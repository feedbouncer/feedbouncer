import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import {
  EXECUTE_JOB,
  ModerationActions,
  PgCommentStore,
  executeActionJob,
  type ActionOutcomeObserver,
} from '@feedbouncer/comments';
import {
  ConnectorError,
  type ConnectorCapabilities,
  type ConnectorRuntime,
} from '@feedbouncer/connectors';
import type { JobContext } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { createLogger } from '@feedbouncer/service-runtime';
import { PgEvaluationStore } from './evaluations.js';
import { RuleActionFallback } from './fallback.js';

type Outcome = Parameters<ActionOutcomeObserver['onActionOutcome']>[0];

const quiet = createLogger('rules-fallback-test', 'error', () => {});
let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let comments: PgCommentStore;
let evaluations: PgEvaluationStore;
let fallback: RuleActionFallback;
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'rules-fallback-test', onIdleError: () => {} });
  comments = new PgCommentStore(pool);
  evaluations = new PgEvaluationStore(pool);
  fallback = new RuleActionFallback({ evaluations, log: quiet });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

interface Seeded {
  t: Tenant;
  scope: ConnectionScope;
  commentId: string;
  evaluationId: string;
}

async function seed(): Promise<Seeded> {
  const t = await seedTenant(ctx.c, `fb${++n}`);
  const scope = {
    organizationId: t.organizationId,
    brandId: t.brandId,
    connectionId: t.connectionId,
  };
  const c = await comments.upsertFromPlatform(
    scope,
    {
      externalId: `c_${n}`,
      sourceExternalId: `post_${n}`,
      parentExternalId: null,
      author: { externalId: `a_${n}`, displayName: 'Someone', profileUrl: null },
      body: 'buy spam',
      postedAt: new Date(),
      platformState: 'visible',
      permalink: null,
    },
    { ownAccountExternalId: 'page', syncedAt: new Date() },
  );
  const rule = await ctx.c.query<{ id: string }>(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, mode)
     VALUES ($1, $2, 'No spam', '{"type":"keyword","terms":["spam"]}', 'hide', 'enforce')
     RETURNING id`,
    [t.organizationId, t.brandId],
  );
  const ruleId = rule.rows[0]!.id;
  const row = await evaluations.record(scope, {
    commentId: c.commentId,
    sha: createHash('sha256').update('buy spam', 'utf8').digest(),
    triggerKey: 'ingest',
    rulesetVersion: 'v1',
    status: 'decided',
    verdict: {
      suggestions: [],
      decided: {
        ruleId,
        ruleName: 'No spam',
        kind: 'keyword',
        action: 'hide',
        evidence: { kind: 'keyword', term: 'spam' },
      },
      trace: [],
    },
  });
  return { t, scope, commentId: c.commentId, evaluationId: row!.id };
}

const outcome = (s: Seeded, o: Partial<Outcome>): Outcome => ({
  scope: s.scope,
  platform: 'facebook',
  actionId: randomUUID(),
  commentId: s.commentId,
  kind: 'hide',
  actorType: 'rule',
  ruleId: null,
  requestKey: `rule-eval:${s.evaluationId}`,
  status: 'failed',
  code: null,
  ...o,
});

const decisions = async (commentId: string) =>
  (
    await pool.query<{ outcome: string; mode: string; reason: string }>(
      `SELECT outcome, mode, reason FROM decision WHERE comment_id = $1 ORDER BY sequence`,
      [commentId],
    )
  ).rows;
const evaluation = async (id: string) =>
  (
    await pool.query(
      `SELECT fallback_code, fallback_at IS NOT NULL AS fell_back, recovered_at IS NOT NULL AS recovered
         FROM rule_evaluation WHERE id = $1`,
      [id],
    )
  ).rows[0];

describe('RuleActionFallback', () => {
  it('flags the comment when the action fails', async () => {
    const s = await seed();
    await fallback.onActionOutcome(outcome(s, { status: 'failed', code: 'permission_revoked' }));
    const ds = await decisions(s.commentId);
    expect(ds.map((d) => [d.outcome, d.mode])).toEqual([
      ['hide', 'enforce'],
      ['flag', 'enforce'],
    ]);
    expect(ds[1]!.reason).toContain('permission was revoked');
    expect(await evaluation(s.evaluationId)).toMatchObject({
      fallback_code: 'permission_revoked',
      fell_back: true,
    });
  });

  it('flags once for repeated deferrals', async () => {
    const s = await seed();
    const e = outcome(s, { status: 'deferred', code: 'rate_limited' });
    await fallback.onActionOutcome(e);
    await fallback.onActionOutcome(e);
    expect((await decisions(s.commentId)).filter((d) => d.outcome === 'flag')).toHaveLength(1);
  });

  it('records the recovery when a deferred action is applied', async () => {
    const s = await seed();
    await fallback.onActionOutcome(outcome(s, { status: 'deferred', code: 'rate_limited' }));
    await fallback.onActionOutcome(outcome(s, { status: 'applied' }));
    const ds = await decisions(s.commentId);
    expect(ds.map((d) => d.outcome)).toEqual(['hide', 'flag', 'hide']);
    expect(ds[2]!.reason).toContain('after a retry');
    expect(await evaluation(s.evaluationId)).toMatchObject({ recovered: true });
  });

  it('adds nothing when an action applies without a fallback, or is a noop', async () => {
    const s = await seed();
    await fallback.onActionOutcome(outcome(s, { status: 'applied' }));
    await fallback.onActionOutcome(outcome(s, { status: 'noop' }));
    expect(await decisions(s.commentId)).toHaveLength(1);
  });

  it('ignores user actions and other request keys', async () => {
    const s = await seed();
    await fallback.onActionOutcome(outcome(s, { actorType: 'user', code: 'failed' }));
    await fallback.onActionOutcome(outcome(s, { requestKey: `rk-${s.evaluationId}` }));
    expect(await decisions(s.commentId)).toHaveLength(1);
  });

  it('logs and ignores a malformed evaluation id', async () => {
    const s = await seed();
    const warn = vi.fn();
    const f = new RuleActionFallback({
      evaluations,
      log: { ...quiet, warn } as unknown as typeof quiet,
    });
    await f.onActionOutcome(outcome(s, { requestKey: 'rule-eval:not-a-uuid' }));
    expect(warn).toHaveBeenCalledWith('rule_fallback_bad_request_key', expect.any(Object));
    expect(await decisions(s.commentId)).toHaveLength(1);
  });

  it('does not touch another brand evaluation', async () => {
    const a = await seed();
    const b = await seed();
    await fallback.onActionOutcome(outcome(a, { scope: b.scope, code: 'failed' }));
    expect(await decisions(a.commentId)).toHaveLength(1);
    expect(await evaluation(a.evaluationId)).toMatchObject({ fell_back: false });
  });

  it('propagates store failures to the caller, which logs them', async () => {
    const s = await seed();
    const broken = new RuleActionFallback({
      evaluations: {
        loadForFallback: async () => {
          throw new Error('db down');
        },
      } as unknown as PgEvaluationStore,
      log: quiet,
    });
    await expect(broken.onActionOutcome(outcome(s, { code: 'failed' }))).rejects.toThrow('db down');
  });
});

describe('RuleActionFallback through the execute job', () => {
  it('flags while the throttled action stays pending, then records the recovery', async () => {
    const s = await seed();
    const capabilities = {
      actions: ['hide'],
      maxPageSize: 100,
    } as unknown as ConnectorCapabilities;
    const actions = new ModerationActions({
      pool,
      store: comments,
      producer: {
        enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
      } as never,
      capabilities: () => capabilities,
      clock: { now: () => Date.now() },
      log: quiet,
    });
    const requested = await actions.request({
      scope: s.scope,
      commentId: s.commentId,
      kind: 'hide',
      actor: {
        type: 'rule',
        ruleId: (await evaluations.loadForFallback(s.scope, s.evaluationId))!.ruleId,
      },
      requestKey: `rule-eval:${s.evaluationId}`,
    });
    if (requested.status !== 'accepted') throw new Error('action not accepted');

    let act: () => Promise<unknown> = async () => ({
      status: 'failed',
      error: new ConnectorError('rate_limited', 'rate_limited', { retryAfterMs: 1_000 }),
    });
    const runtime = {
      connect: async () => ({ act: () => act() }),
    } as unknown as ConnectorRuntime;
    const job = executeActionJob({
      pool,
      runtime,
      log: quiet,
      producer: {
        enqueue: vi.fn(async () => ({ status: 'enqueued' as const, ledgerId: 'l', jobId: 'j' })),
      },
      clock: { now: () => Date.now() },
      outcomes: fallback,
    });
    const jobCtx: JobContext = {
      scope: s.scope,
      platform: 'facebook',
      jobType: EXECUTE_JOB.type,
      ledgerId: randomUUID(),
      attempt: 1,
      isReplay: false,
      signal: AbortSignal.timeout(30_000),
      log: quiet,
    };
    const payload = EXECUTE_JOB.payload.parse({ actionId: requested.action.id });

    await expect(job.handle(jobCtx, payload)).rejects.toMatchObject({ kind: 'rate_limited' });
    const status = async () =>
      (
        await pool.query<{ status: string }>('SELECT status FROM moderation_action WHERE id = $1', [
          requested.action.id,
        ])
      ).rows[0]!.status;
    expect(await status()).toBe('pending');
    expect((await decisions(s.commentId)).map((d) => d.outcome)).toEqual(['hide', 'flag']);

    act = async () => ({ status: 'applied', platformActionId: 'p1' });
    await job.handle({ ...jobCtx, attempt: 2 }, payload);
    expect(await status()).toBe('applied');
    expect((await decisions(s.commentId)).map((d) => d.outcome)).toEqual(['hide', 'flag', 'hide']);
  });
});
