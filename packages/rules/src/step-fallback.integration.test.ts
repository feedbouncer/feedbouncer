import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { ActionStepObserver } from '@feedbouncer/actions';
import { PgCommentStore } from '@feedbouncer/comments';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant } from '@feedbouncer/db/testing';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { createLogger } from '@feedbouncer/service-runtime';
import { PgEvaluationStore } from './evaluations.js';
import { RuleStepFallback } from './step-fallback.js';

type Settled = Parameters<ActionStepObserver['onStepSettled']>[0];

const quiet = createLogger('rules-step-fallback-test', 'error', () => {});
let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let comments: PgCommentStore;
let evaluations: PgEvaluationStore;
let fallback: RuleStepFallback;
let n = 0;

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, {
    applicationName: 'rules-step-fallback-test',
    onIdleError: () => {},
  });
  comments = new PgCommentStore(pool);
  evaluations = new PgEvaluationStore(pool);
  fallback = new RuleStepFallback({ evaluations, log: quiet });
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});

interface Seeded {
  scope: ConnectionScope;
  commentId: string;
  evaluationId: string;
  ruleId: string;
}

async function seed(): Promise<Seeded> {
  const t = await seedTenant(ctx.c, `sf${++n}`);
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
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, actions, mode)
     VALUES ($1, $2, 'No spam', '{"type":"keyword","terms":["spam"]}', 'hide', '[{"type":"hide"}]', 'enforce')
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
      alsoMatched: [],
      decided: {
        ruleId,
        ruleName: 'No spam',
        kind: 'keyword',
        action: 'hide',
        actions: [{ type: 'hide' }],
        evidence: { kind: 'keyword', term: 'spam' },
      },
      trace: [],
    },
  });
  return { scope, commentId: c.commentId, evaluationId: row!.id, ruleId };
}

const settled = (s: Seeded, o: Partial<Settled>): Settled => ({
  scope: s.scope,
  runId: randomUUID(),
  stepId: randomUUID(),
  ruleId: s.ruleId,
  evaluationId: s.evaluationId,
  commentId: s.commentId,
  type: 'hide',
  status: 'failed',
  reason: null,
  ...o,
});

const decisions = async (commentId: string) =>
  (
    await pool.query<{ outcome: string; mode: string; reason: string }>(
      `SELECT outcome, mode, reason FROM decision WHERE comment_id = $1 ORDER BY sequence`,
      [commentId],
    )
  ).rows;
const reviewItems = async (commentId: string) =>
  (
    await pool.query<{ source: string; status: string }>(
      `SELECT source, status FROM review_item WHERE comment_id = $1`,
      [commentId],
    )
  ).rows;
const fellBack = async (id: string) =>
  (
    await pool.query<{ fallback_code: string | null; fell_back: boolean }>(
      `SELECT fallback_code, fallback_at IS NOT NULL AS fell_back FROM rule_evaluation WHERE id = $1`,
      [id],
    )
  ).rows[0]!;

describe('RuleStepFallback', () => {
  it('failed hide step records the rule fallback and opens a review item', async () => {
    const s = await seed();
    await fallback.onStepSettled(settled(s, { status: 'failed', reason: 'missing_permission' }));
    expect(await fellBack(s.evaluationId)).toEqual({
      fallback_code: 'missing_permission',
      fell_back: true,
    });
    const ds = await decisions(s.commentId);
    expect(ds.map((d) => [d.outcome, d.mode])).toEqual([
      ['hide', 'enforce'],
      ['flag', 'enforce'],
    ]);
    expect(ds[1]!.reason).toContain('Flagged for review');
    expect(ds[1]!.reason).toContain('wanted to hide');
    expect(await reviewItems(s.commentId)).toEqual([{ source: 'rule', status: 'open' }]);
  });

  it('a not_supported delete step falls back and names the platform', async () => {
    const s = await seed();
    await fallback.onStepSettled(
      settled(s, { type: 'delete', status: 'not_supported', reason: 'unsupported' }),
    );
    expect((await fellBack(s.evaluationId)).fallback_code).toBe('unsupported');
    const ds = await decisions(s.commentId);
    expect(ds[1]!.reason).toContain('wanted to delete');
    expect(ds[1]!.reason).toContain('Facebook');
  });

  it('is written once however often the event is redelivered', async () => {
    const s = await seed();
    const e = settled(s, { reason: 'rate_limit_exhausted' });
    await fallback.onStepSettled(e);
    await fallback.onStepSettled(e);
    await fallback.onStepSettled(settled(s, { type: 'delete', status: 'not_supported' }));
    expect(await decisions(s.commentId)).toHaveLength(2);
    expect(await reviewItems(s.commentId)).toHaveLength(1);
  });

  it('ignores approval runs, which have no rule', async () => {
    const s = await seed();
    await fallback.onStepSettled(
      settled(s, {
        ruleId: null,
        evaluationId: null,
        status: 'failed',
        reason: 'missing_permission',
      }),
    );
    expect((await fellBack(s.evaluationId)).fell_back).toBe(false);
    expect(await decisions(s.commentId)).toHaveLength(1);
  });

  it('ignores steps that went well, other step types and other statuses', async () => {
    const s = await seed();
    await fallback.onStepSettled(settled(s, { status: 'succeeded' }));
    await fallback.onStepSettled(settled(s, { status: 'skipped', reason: 'already_hidden' }));
    await fallback.onStepSettled(settled(s, { type: 'ban', status: 'failed' }));
    await fallback.onStepSettled(settled(s, { type: 'auto_reply', status: 'not_supported' }));
    await fallback.onStepSettled(settled(s, { type: 'flag_for_review', status: 'failed' }));
    expect((await fellBack(s.evaluationId)).fell_back).toBe(false);
    expect(await decisions(s.commentId)).toHaveLength(1);
  });

  it('does not act on an evaluation of another brand', async () => {
    const s = await seed();
    const other = await seed();
    await fallback.onStepSettled(
      settled(s, { scope: { ...other.scope }, evaluationId: s.evaluationId }),
    );
    expect((await fellBack(s.evaluationId)).fell_back).toBe(false);
  });
});
