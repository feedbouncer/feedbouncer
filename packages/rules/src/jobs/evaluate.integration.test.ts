// rule_evaluate over real Postgres: real comment store, rule store/cache and
// ModerationActions (stub job producer, fake connector capabilities).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import {
  ActionRunner,
  PgActionRunStore,
  PgReviewQueue,
  deriveOutcome,
  undoStep,
  type ActionStep,
} from '@feedbouncer/actions';
import { ModerationActions, PgCommentStore } from '@feedbouncer/comments';
import type { ConnectorCapabilities, Platform } from '@feedbouncer/connectors';
import type { JobContext } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { createLogger, type Logger } from '@feedbouncer/service-runtime';
import type { RuleEvaluatedHook } from '../hooks.js';
import { PgRuleStore } from '../store.js';
import { RuleSetCache } from '../cache.js';
import { PgEvaluationStore } from '../evaluations.js';
import { RuleStepFallback } from '../step-fallback.js';
import { ruleEvaluateJob } from './evaluate.js';
import { RULE_EVALUATE_JOB, RuleEvaluatePayload, bodySha256 } from './specs.js';

const PAGE = '1000000001';
const IG_ACCOUNT = '17841400000000001';
const quiet = createLogger('rules-evaluate-test', 'error', () => {});
const caps = (actions: string[]) =>
  ({ actions, maxPageSize: 100 }) as unknown as ConnectorCapabilities;
const capabilities = (p: Platform) =>
  p === 'facebook'
    ? caps(['hide', 'unhide', 'delete'])
    : p === 'instagram'
      ? caps(['hide', 'unhide']) // no delete: rule deletes are refused as unsupported
      : undefined;

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let comments: PgCommentStore;
let evaluations: PgEvaluationStore;
let cache: RuleSetCache;
let actions: ModerationActions;
let runner: ActionRunner;
let rules: PgRuleStore;
let enqueue: ReturnType<typeof vi.fn>;
let n = 0;
let nowMs = Date.UTC(2026, 9, 15, 12, 0, 0);

interface Env {
  t: Tenant;
  scope: ConnectionScope;
  igScope: ConnectionScope;
}

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'rules-evaluate-test', onIdleError: () => {} });
  comments = new PgCommentStore(pool);
  evaluations = new PgEvaluationStore(pool);
  rules = new PgRuleStore(pool);
  cache = new RuleSetCache(rules);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(() => {
  nowMs += 60_000;
  enqueue = vi.fn(async () => ({ status: 'enqueued', ledgerId: 'l', jobId: 'j' }));
  actions = new ModerationActions({
    pool,
    store: comments,
    producer: { enqueue } as never,
    capabilities,
    clock: { now: () => nowMs },
    log: quiet,
  });
  runner = new ActionRunner({
    pool,
    runs: new PgActionRunStore(pool),
    review: new PgReviewQueue(pool),
    comments,
    actions,
    connection: async (s) => {
      const r = await pool.query<{ platform: Platform }>(
        'SELECT platform FROM connection WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
        [s.organizationId, s.brandId, s.connectionId],
      );
      const platform = r.rows[0]?.platform;
      const c = platform && capabilities(platform);
      return platform && c
        ? { connectionId: s.connectionId, platform, caps: c, grantedScopes: [] }
        : null;
    },
    brandName: async () => 'Shop',
    producer: { enqueue } as never,
    clock: { now: () => nowMs },
    log: quiet,
    observer: new RuleStepFallback({ evaluations, log: quiet }),
  });
});

async function env(): Promise<Env> {
  const t = await seedTenant(ctx.c, `re${++n}`);
  await ctx.c.query('UPDATE rule SET archived_at = now(), enabled = false WHERE brand_id = $1', [
    t.brandId,
  ]);
  await ctx.c.query('UPDATE connection SET external_account_id = $1 WHERE id = $2', [
    `${PAGE}${n}`,
    t.connectionId,
  ]);
  const ig = await ctx.c.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
     VALUES ($1, $2, 'instagram', $3) RETURNING id`,
    [t.organizationId, t.brandId, `${IG_ACCOUNT}${n}`],
  );
  const scope = {
    organizationId: t.organizationId,
    brandId: t.brandId,
    connectionId: t.connectionId,
  };
  return { t, scope, igScope: { ...scope, connectionId: ig.rows[0]!.id } };
}

async function addRule(
  e: Env,
  conditions: object,
  o: { actions?: ActionStep[]; mode?: 'enforce' | 'suggest'; priority: number; name?: string },
): Promise<string> {
  const steps = o.actions ?? HIDE;
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO rule (organization_id, brand_id, name, conditions, action, actions, mode, priority)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8) RETURNING id`,
    [
      e.t.organizationId,
      e.t.brandId,
      o.name ?? `rule ${o.priority}`,
      JSON.stringify(conditions),
      deriveOutcome(steps),
      JSON.stringify(steps),
      o.mode ?? 'enforce',
      o.priority,
    ],
  );
  return r.rows[0]!.id;
}
const HIDE: ActionStep[] = [{ type: 'hide' }];
const FLAG: ActionStep[] = [{ type: 'flag_for_review' }];
const DELETE: ActionStep[] = [{ type: 'delete', confirmIrreversible: true }];
const kw = (...terms: string[]) => ({ type: 'keyword', terms });

let seq = 0;
async function comment(
  e: Env,
  body: string,
  o: {
    ig?: boolean;
    own?: boolean;
    state?: 'visible' | 'hidden' | 'deleted';
    externalId?: string;
  } = {},
): Promise<{ id: string; externalId: string }> {
  const s = o.ig ? e.igScope : e.scope;
  const owner = o.ig ? `${IG_ACCOUNT}${n}` : `${PAGE}${n}`;
  const externalId = o.externalId ?? `c_${++seq}`;
  const r = await comments.upsertFromPlatform(
    s,
    {
      externalId,
      sourceExternalId: o.ig ? '17900000000000001' : `${PAGE}_1`,
      parentExternalId: null,
      author: {
        externalId: o.own ? owner : `author_${seq}`,
        displayName: 'Alice Author',
        profileUrl: null,
      },
      body,
      postedAt: new Date(nowMs - 60_000),
      platformState: o.state ?? 'visible',
      permalink: null,
    },
    { ownAccountExternalId: owner, syncedAt: new Date((nowMs += 1_000)) },
  );
  return { id: r.commentId, externalId };
}

const jobCtx = (scope: ConnectionScope, platform: Platform = 'facebook'): JobContext => ({
  scope,
  platform,
  jobType: RULE_EVALUATE_JOB.type,
  ledgerId: randomUUID(),
  attempt: 1,
  isReplay: false,
  signal: AbortSignal.timeout(30_000),
  log: quiet,
});

function run(
  scope: ConnectionScope,
  commentId: string,
  body: string,
  o: {
    log?: Logger;
    clock?: { now(): number };
    platform?: Platform;
    evaluated?: RuleEvaluatedHook;
    runner?: Pick<ActionRunner, 'start'>;
  } = {},
) {
  const job = ruleEvaluateJob({
    comments,
    evaluations,
    cache,
    runner: o.runner ?? runner,
    rules,
    log: o.log ?? quiet,
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.evaluated ? { evaluated: o.evaluated } : {}),
  });
  const p = RuleEvaluatePayload.parse({
    commentId,
    bodySha256: bodySha256(body),
    trigger: 'ingest',
  });
  return job.handle(jobCtx(scope, o.platform), p);
}

const evals = async (commentId: string) =>
  (
    await pool.query(
      `SELECT id, status, skip_reason, matched_rule_id, outcome, trigger_key, trace, fallback_code,
              fallback_at
         FROM rule_evaluation WHERE comment_id = $1 ORDER BY created_at, id`,
      [commentId],
    )
  ).rows;
const decisions = async (commentId: string) =>
  (
    await pool.query(
      `SELECT outcome, mode, actor_type, rule_id, reason, rule_evaluation_id
         FROM decision WHERE comment_id = $1 ORDER BY sequence`,
      [commentId],
    )
  ).rows;
const runRows = async (commentId: string) =>
  (
    await pool.query<{ id: string; dry_run: boolean; rule_id: string; steps: string[] }>(
      `SELECT r.id, r.dry_run, r.rule_id,
              array(SELECT step_type FROM action_run_step s WHERE s.run_id = r.id ORDER BY position) AS steps
         FROM action_run r WHERE r.comment_id = $1 ORDER BY r.created_at, r.id`,
      [commentId],
    )
  ).rows;
const stepRows = async (runId: string) =>
  (
    await pool.query<{ step_type: string; status: string; reason_code: string | null }>(
      `SELECT step_type, status, reason_code FROM action_run_step WHERE run_id = $1 ORDER BY position`,
      [runId],
    )
  ).rows;
/** Runs the queued advance of every enforcing run of the comment, as the worker would. */
async function advanceRuns(scope: ConnectionScope, commentId: string) {
  for (const r of await runRows(commentId)) if (!r.dry_run) await runner.advance(scope, r.id);
}
const actionRows = async (commentId: string) =>
  (
    await pool.query(
      `SELECT kind, status, actor_type, rule_id, request_key FROM moderation_action
        WHERE comment_id = $1 ORDER BY created_at`,
      [commentId],
    )
  ).rows;

describe('rule_evaluate', () => {
  it('1: a hide rule match records a decided evaluation, an enforce decision and one run that requests the hide', async () => {
    const e = await env();
    const ruleId = await addRule(e, kw('spam'), { name: 'No spam', priority: 10 });
    const c = await comment(e, 'this is SPAM here');
    const r = await run(e.scope, c.id, 'this is SPAM here');
    expect(r).toMatchObject({ result: 'decided', outcome: 'hide' });
    const ev = await evals(c.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ status: 'decided', outcome: 'hide', matched_rule_id: ruleId });
    expect(await decisions(c.id)).toEqual([
      {
        outcome: 'hide',
        mode: 'enforce',
        actor_type: 'rule',
        rule_id: ruleId,
        reason: 'Rule "No spam" (keyword): matched "spam".',
        rule_evaluation_id: ev[0].id,
      },
    ]);
    expect(await actionRows(c.id)).toEqual([]);
    expect(await runRows(c.id)).toMatchObject([
      { dry_run: false, rule_id: ruleId, steps: ['hide'] },
    ]);
    await advanceRuns(e.scope, c.id);
    expect(await actionRows(c.id)).toEqual([
      {
        kind: 'hide',
        status: 'pending',
        actor_type: 'rule',
        rule_id: ruleId,
        request_key: `auto:${c.id}:hide`,
      },
    ]);
  });

  it('2: a decided rule starts one run with its steps; re-running the job starts none', async () => {
    const e = await env();
    await addRule(e, kw('spam'), {
      actions: [{ type: 'hide' }, { type: 'flag_for_review' }],
      priority: 10,
    });
    const c = await comment(e, 'spam');
    const first = await run(e.scope, c.id, 'spam');
    await run(e.scope, c.id, 'spam');
    expect(first).toMatchObject({ result: 'decided', runId: expect.any(String) });
    expect(await evals(c.id)).toHaveLength(1);
    expect(await decisions(c.id)).toHaveLength(1);
    expect(await runRows(c.id)).toMatchObject([{ steps: ['flag_for_review', 'hide'] }]);
    await advanceRuns(e.scope, c.id);
    expect(await actionRows(c.id)).toHaveLength(1);
  });

  it('a rule with no steps decides without starting a run', async () => {
    const e = await env();
    await addRule(e, kw('winner'), { actions: [], priority: 10 });
    const c = await comment(e, 'winner');
    expect(await run(e.scope, c.id, 'winner')).toMatchObject({ result: 'decided' });
    expect(await runRows(c.id)).toEqual([]);
  });

  it('resuming a recorded evaluation starts the run from the stored rule', async () => {
    const e = await env();
    const ruleId = await addRule(e, kw('spam'), { priority: 10 });
    const c = await comment(e, 'spam');
    const failing = { start: vi.fn().mockRejectedValueOnce(new Error('queue down')) };
    await expect(run(e.scope, c.id, 'spam', { runner: failing })).rejects.toThrow('queue down');
    expect(await runRows(c.id)).toEqual([]);
    await run(e.scope, c.id, 'spam');
    expect(await runRows(c.id)).toMatchObject([{ rule_id: ruleId, steps: ['hide'] }]);
  });

  it('3: a dry-run hide plus an enforcing flag gives a suggest and an enforce decision, no action', async () => {
    const e = await env();
    const dry = await addRule(e, kw('spam'), { mode: 'suggest', priority: 10 });
    const flag = await addRule(e, kw('spam'), { actions: FLAG, priority: 20 });
    const c = await comment(e, 'spam');
    await run(e.scope, c.id, 'spam');
    const ds = await decisions(c.id);
    expect(ds.map((d) => [d.outcome, d.mode, d.rule_id])).toEqual([
      ['hide', 'suggest', dry],
      ['flag', 'enforce', flag],
    ]);
    expect(await actionRows(c.id)).toEqual([]);
  });

  it('a flag rule: the decision opens the item, the flag step owns it, and undo dismisses it', async () => {
    const e = await env();
    const ruleId = await addRule(e, kw('spam'), { actions: FLAG, priority: 10 });
    const c = await comment(e, 'spam');
    await run(e.scope, c.id, 'spam');
    const items = async () =>
      (
        await pool.query<{ id: string; source: string; rule_id: string; status: string }>(
          `SELECT id, source, rule_id, status, resolution FROM review_item WHERE comment_id = $1`,
          [c.id],
        )
      ).rows;
    const [item] = await items();
    expect(item).toMatchObject({ source: 'rule', rule_id: ruleId, status: 'open' });

    await advanceRuns(e.scope, c.id);
    const [r] = await runRows(c.id);
    const step = (
      await pool.query<{ id: string; status: string; review_item_id: string | null }>(
        'SELECT id, status, review_item_id FROM action_run_step WHERE run_id = $1',
        [r!.id],
      )
    ).rows[0]!;
    expect(step).toMatchObject({ status: 'succeeded', review_item_id: item!.id });

    const runs = new PgActionRunStore(pool);
    const review = new PgReviewQueue(pool);
    expect(await undoStep({ pool, runs, review, actions }, e.scope, step.id, e.t.userId)).toEqual({
      status: 'done',
      undoActionId: null,
    });
    expect(await items()).toEqual([
      expect.objectContaining({ id: item!.id, status: 'resolved', resolution: 'dismissed' }),
    ]);
  });

  it('a later evaluation of the same rule does not take over the open item', async () => {
    const e = await env();
    await addRule(e, kw('spam'), { actions: FLAG, priority: 10 });
    const c = await comment(e, 'spam');
    await run(e.scope, c.id, 'spam');
    await advanceRuns(e.scope, c.id);
    // An edit is a new evaluation; its decision finds the item already open.
    await pool.query('UPDATE comment SET body = $1 WHERE id = $2', ['more spam', c.id]);
    await run(e.scope, c.id, 'more spam');
    await advanceRuns(e.scope, c.id);
    const steps = (
      await pool.query<{ status: string; reason_code: string | null }>(
        `SELECT s.status, s.reason_code FROM action_run_step s JOIN action_run r ON r.id = s.run_id
          WHERE r.comment_id = $1 ORDER BY r.created_at, r.id`,
        [c.id],
      )
    ).rows;
    expect(steps).toEqual([
      { status: 'succeeded', reason_code: null },
      { status: 'skipped', reason_code: 'already_flagged' },
    ]);
  });

  it('suggest-mode match produces a simulated run and no moderation_action', async () => {
    const e = await env();
    const dry = await addRule(e, kw('spam'), { mode: 'suggest', priority: 10 });
    const c = await comment(e, 'spam');
    expect(await run(e.scope, c.id, 'spam')).toMatchObject({ result: 'no_match' });
    const runs = await runRows(c.id);
    expect(runs).toMatchObject([{ dry_run: true, rule_id: dry, steps: ['hide'] }]);
    expect(await stepRows(runs[0]!.id)).toEqual([
      { step_type: 'hide', status: 'simulated', reason_code: 'would_run' },
    ]);
    await run(e.scope, c.id, 'spam');
    expect(await runRows(c.id)).toHaveLength(1);
    expect(await actionRows(c.id)).toEqual([]);
  });

  it('a suggest-mode match with no steps still gets a completed, empty simulated run', async () => {
    const e = await env();
    await addRule(e, kw('spam'), { mode: 'suggest', actions: [], priority: 10 });
    const c = await comment(e, 'spam');
    await run(e.scope, c.id, 'spam');
    const runs = await runRows(c.id);
    expect(runs).toMatchObject([{ dry_run: true, steps: [] }]);
    expect(await stepRows(runs[0]!.id)).toEqual([]);
  });

  it('4: no match records no_match and no decisions', async () => {
    const e = await env();
    await addRule(e, kw('spam'), { priority: 10 });
    const c = await comment(e, 'lovely product');
    expect(await run(e.scope, c.id, 'lovely product')).toMatchObject({ result: 'no_match' });
    expect((await evals(c.id)).map((x) => x.status)).toEqual(['no_match']);
    expect(await decisions(c.id)).toEqual([]);
  });

  it('5: an own-account comment is skipped', async () => {
    const e = await env();
    await addRule(e, kw('spam'), { priority: 10 });
    const c = await comment(e, 'spam', { own: true });
    expect(await run(e.scope, c.id, 'spam')).toMatchObject({ result: 'skipped' });
    expect(await evals(c.id)).toMatchObject([{ status: 'skipped', skip_reason: 'own_account' }]);
    expect(await decisions(c.id)).toEqual([]);
    expect(await actionRows(c.id)).toEqual([]);
  });

  it('6: a deleted comment is skipped', async () => {
    const e = await env();
    await addRule(e, kw('spam'), { priority: 10 });
    const c = await comment(e, 'spam', { state: 'deleted' });
    expect(await run(e.scope, c.id, 'spam')).toMatchObject({ result: 'skipped' });
    expect(await evals(c.id)).toMatchObject([{ status: 'skipped', skip_reason: 'deleted' }]);
    expect(await decisions(c.id)).toEqual([]);
  });

  it('7: a payload sha that differs from the current body is superseded', async () => {
    const e = await env();
    await addRule(e, kw('spam'), { priority: 10 });
    const c = await comment(e, 'spam now');
    expect(await run(e.scope, c.id, 'spam before')).toEqual({ result: 'superseded' });
    expect(await evals(c.id)).toEqual([]);
  });

  it('8: a comment of another connection or tenant is gone', async () => {
    const a = await env();
    const b = await env();
    await addRule(a, kw('spam'), { priority: 10 });
    await addRule(b, kw('spam'), { priority: 10 });
    const c = await comment(a, 'spam');
    expect(await run(b.scope, c.id, 'spam')).toEqual({ result: 'gone' });
    expect(await run(a.igScope, c.id, 'spam')).toEqual({ result: 'gone' });
    expect(await evals(c.id)).toEqual([]);
    expect(await actionRows(c.id)).toEqual([]);
  });

  it('9: a delete the platform does not support falls back to a flag decision', async () => {
    const e = await env();
    const ruleId = await addRule(e, kw('scam'), { actions: DELETE, name: 'Scams', priority: 10 });
    const c = await comment(e, 'a scam', { ig: true });
    const r = await run(e.igScope, c.id, 'a scam', { platform: 'instagram' });
    expect(r).toMatchObject({ result: 'decided', outcome: 'remove' });
    await advanceRuns(e.igScope, c.id);
    const ev = await evals(c.id);
    expect(ev[0].fallback_code).toBe('unsupported');
    const ds = await decisions(c.id);
    expect(ds.map((d) => [d.outcome, d.mode])).toEqual([
      ['remove', 'enforce'],
      ['flag', 'enforce'],
    ]);
    expect(ds[1].rule_id).toBe(ruleId);
    expect(ds[1].reason).toContain('Flagged for review');
    expect(ds[1].reason).toContain('Instagram');
    expect(await actionRows(c.id)).toEqual([]);
    // A rerun does not add a second fallback or start the actions again.
    expect(await run(e.igScope, c.id, 'a scam', { platform: 'instagram' })).toMatchObject({
      fallback: 'recorded',
    });
    expect(await decisions(c.id)).toHaveLength(2);
    expect(await runRows(c.id)).toHaveLength(1);
  });

  it('10: a connection that needs reconnecting falls back to a flag decision', async () => {
    const e = await env();
    await addRule(e, kw('spam'), { priority: 10 });
    const c = await comment(e, 'spam');
    await ctx.c.query(`UPDATE connection SET status = 'reconnect_required' WHERE id = $1`, [
      e.t.connectionId,
    ]);
    await run(e.scope, c.id, 'spam');
    await advanceRuns(e.scope, c.id);
    expect((await evals(c.id))[0].fallback_code).toBe('connection_needs_reconnect');
    const ds = await decisions(c.id);
    expect(ds.map((d) => d.outcome)).toEqual(['hide', 'flag']);
    expect(ds[1].reason).toContain('reconnect');
  });

  it('11: a regex over budget is skipped, a later rule decides, and the log carries no comment text', async () => {
    const e = await env();
    const slow = await addRule(e, { type: 'regex', patterns: ['zz+top'] }, { priority: 10 });
    const later = await addRule(e, kw('secretword'), { actions: FLAG, priority: 20 });
    const body = 'Alice says secretword and zzzzztop';
    const c = await comment(e, body);
    const lines: string[] = [];
    const log = createLogger('rules-evaluate-test', 'debug', (l) => lines.push(l));
    let t = 0;
    await run(e.scope, c.id, body, { log, clock: { now: () => (t += 100) } });
    const ev = await evals(c.id);
    expect(ev[0].trace[0]).toMatchObject({
      ruleId: slow,
      result: 'skipped',
      skipReason: 'timeout',
    });
    expect(ev[0]).toMatchObject({ status: 'decided', matched_rule_id: later, outcome: 'flag' });
    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records).toContainEqual(
      expect.objectContaining({ msg: 'rule_evaluation_timeout', ruleId: slow, commentId: c.id }),
    );
    const all = JSON.stringify(records);
    expect(all).not.toContain('secretword');
    expect(all).not.toContain('zzzzztop');
    expect(all).not.toContain('Alice');
  });

  it('12: an edit is a new body version and gets its own evaluation', async () => {
    const e = await env();
    await addRule(e, kw('spam'), { priority: 10 });
    const c = await comment(e, 'fine text');
    await run(e.scope, c.id, 'fine text');
    await comment(e, 'now spam', { externalId: c.externalId });
    expect(await run(e.scope, c.id, 'fine text')).toEqual({ result: 'superseded' });
    await run(e.scope, c.id, 'now spam');
    const ev = await evals(c.id);
    expect(ev.map((x) => x.status)).toEqual(['no_match', 'decided']);
    await advanceRuns(e.scope, c.id);
    expect(await actionRows(c.id)).toHaveLength(1);
  });

  it('13: an approve rule above a hide rule decides approve with no action', async () => {
    const e = await env();
    const approve = await addRule(e, kw('winner'), { actions: [], priority: 10 });
    await addRule(e, kw('spam'), { priority: 20 });
    const c = await comment(e, 'winner spam');
    await run(e.scope, c.id, 'winner spam');
    expect(await decisions(c.id)).toMatchObject([
      { outcome: 'approve', mode: 'enforce', rule_id: approve },
    ]);
    expect(await runRows(c.id)).toEqual([]);
    expect(await actionRows(c.id)).toEqual([]);
  });

  it('logs invalid stored rules by id and still evaluates the rest', async () => {
    const e = await env();
    const bad = await addRule(e, { type: 'keyword', terms: 'nope' }, { priority: 5 });
    await addRule(e, kw('spam'), { priority: 10 });
    const c = await comment(e, 'spam');
    const lines: string[] = [];
    const log = createLogger('rules-evaluate-test', 'debug', (l) => lines.push(l));
    expect(await run(e.scope, c.id, 'spam', { log })).toMatchObject({ result: 'decided' });
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ msg: 'rule_conditions_invalid', ruleId: bad }),
    );
  });

  it('calls the evaluated hook after act(), with the evaluation status, once per run', async () => {
    const e = await env();
    await addRule(e, kw('spam'), { priority: 10 });
    const quietC = await comment(e, 'lovely product');
    const hidden = await comment(e, 'spam here');
    const seen: unknown[] = [];
    const evaluated = {
      onEvaluated: async (x: unknown) => {
        seen.push(x);
      },
    };
    await run(e.scope, quietC.id, 'lovely product', { evaluated });
    expect(seen).toEqual([
      {
        scope: e.scope,
        platform: 'facebook',
        commentId: quietC.id,
        bodySha256: bodySha256('lovely product'),
        evaluationId: expect.any(String),
        status: 'no_match',
      },
    ]);
    await run(e.scope, hidden.id, 'spam here', { evaluated });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ commentId: hidden.id, status: 'decided' });
  });

  it('does not call the hook for skipped, gone or superseded comments', async () => {
    const e = await env();
    const other = await env();
    await addRule(e, kw('spam'), { priority: 10 });
    const own = await comment(e, 'spam', { own: true });
    const del = await comment(e, 'spam', { state: 'deleted' });
    const cur = await comment(e, 'spam now');
    const seen: unknown[] = [];
    const evaluated = {
      onEvaluated: async (x: unknown) => {
        seen.push(x);
      },
    };
    expect(await run(e.scope, own.id, 'spam', { evaluated })).toMatchObject({ result: 'skipped' });
    expect(await run(e.scope, del.id, 'spam', { evaluated })).toMatchObject({ result: 'skipped' });
    expect(await run(e.scope, cur.id, 'spam before', { evaluated })).toEqual({
      result: 'superseded',
    });
    expect(await run(other.scope, cur.id, 'spam now', { evaluated })).toEqual({ result: 'gone' });
    expect(seen).toEqual([]);
  });

  it('a failing hook makes the job retry but the run was already started (idempotent on replay)', async () => {
    const e = await env();
    await addRule(e, kw('spam'), { priority: 10 });
    const c = await comment(e, 'spam');
    const evaluated = {
      onEvaluated: async () => {
        throw new Error('queue down');
      },
    };
    await expect(run(e.scope, c.id, 'spam', { evaluated })).rejects.toThrow('queue down');
    expect(await runRows(c.id)).toHaveLength(1);
    expect(await evals(c.id)).toHaveLength(1);
    await run(e.scope, c.id, 'spam');
    expect(await runRows(c.id)).toHaveLength(1);
    await advanceRuns(e.scope, c.id);
    expect(await actionRows(c.id)).toHaveLength(1);
    expect(await evals(c.id)).toHaveLength(1);
    expect(await decisions(c.id)).toHaveLength(1);
  });
});
