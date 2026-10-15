// policy_preview over real Postgres: real comment, rule-evaluation, preview and
// usage stores and BrandSlots, with a scripted evaluator. The job has no way to
// act on a comment, and these tests check that nothing else is written either.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgCommentStore } from '@feedbouncer/comments';
import { PgEvaluationStore } from '@feedbouncer/rules';
import { createLogger } from '@feedbouncer/service-runtime';
import { BrandSlots, ClassifierProviderError } from '@feedbouncer/classifier';
import {
  evaluateRulesFor,
  fakeJobContext,
  scopeOf,
  seedCommentRow,
  type Seeded,
} from '@feedbouncer/classifier/testing';
import type { PolicyEvaluator } from '../evaluator.js';
import { PgPolicyPreviewStore, PreviewInProgressError } from '../previews.js';
import { PgPolicyUsage } from '../usage.js';
import { policyPreviewJob, type PreviewDeps } from './preview.js';
import { POLICY_PREVIEW_JOB } from './specs.js';

const quiet = createLogger('policy-preview-test', 'error', () => {});
const draft = {
  policyId: null,
  text: 'Hide comments telling people to DM another account',
  action: 'hide' as const,
  days: 7,
};

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let slotPool: pg.Pool;
let comments: PgCommentStore;
let ruleEvaluations: PgEvaluationStore;
let previews: PgPolicyPreviewStore;
let usage: PgPolicyUsage;
let slots: BrandSlots;
let n = 0;
let evaluator: {
  enabled: boolean;
  id: string;
  model: string;
  evaluate: ReturnType<typeof vi.fn<PolicyEvaluator['evaluate']>>;
};
let next: ReturnType<typeof vi.fn<PreviewDeps['next']>>;

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, { applicationName: 'policy-preview-test', onIdleError: () => {} });
  slotPool = createPool(db.db.url, {
    applicationName: 'policy-preview-slots',
    onIdleError: () => {},
  });
  comments = new PgCommentStore(pool);
  ruleEvaluations = new PgEvaluationStore(pool);
  previews = new PgPolicyPreviewStore(pool);
  usage = new PgPolicyUsage(pool);
  slots = new BrandSlots(slotPool, 2, 'fb.policy');
});
afterAll(async () => {
  await pool.end();
  await slotPool.end();
  await db.close();
});
beforeEach(() => {
  evaluator = { enabled: true, id: 'openai', model: 'gpt-test', evaluate: vi.fn() };
  next = vi.fn(async () => {});
});

const makeJob = (o: Partial<PreviewDeps> = {}) =>
  policyPreviewJob({
    comments,
    previews,
    evaluator,
    slots,
    usage,
    monthlyCallsPerBrand: 1_000,
    next,
    ...o,
  });

const brandOf = (t: Tenant) => ({ organizationId: t.organizationId, brandId: t.brandId });
const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withTransaction(pool, fn);
const create = (t: Tenant, o: Partial<typeof draft> = {}) =>
  tx((c) => previews.create(c, brandOf(t), { ...draft, ...o, userId: t.userId }));
const ctxFor = (t: Tenant, connectionId: string, attempt = 1) =>
  fakeJobContext(t, attempt, POLICY_PREVIEW_JOB.type, quiet, connectionId);

/** A visible comment the rules left undecided, posted `ageDays` ago. */
async function candidate(t: Tenant, o: { ageDays?: number; body?: string } = {}): Promise<Seeded> {
  const c = await seedCommentRow(db.c, t, o.body ?? `dm my other account ${++n}`);
  if (o.ageDays)
    await db.c.query(
      `UPDATE comment SET posted_at = now() - make_interval(days => $2) WHERE id = $1`,
      [c.id, o.ageDays],
    );
  await evaluateRulesFor(ruleEvaluations, c, 'no_match');
  return c;
}

/** A second connection of the same brand, with a post to attach comments to. */
async function secondConnection(t: Tenant): Promise<Tenant> {
  const conn = await db.c.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
     VALUES ($1, $2, 'facebook', $3) RETURNING id`,
    [t.organizationId, t.brandId, `page-b-${++n}`],
  );
  const src = await db.c.query<{ id: string }>(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'ad_post', $4) RETURNING id`,
    [t.organizationId, t.brandId, conn.rows[0]!.id, `post-b-${n}`],
  );
  return { ...t, connectionId: conn.rows[0]!.id, sourceId: src.rows[0]!.id };
}

async function counts(t: Tenant) {
  const one = async (sql: string) =>
    (await db.c.query<{ n: number }>(sql, [t.organizationId, t.brandId])).rows[0]!.n;
  const scoped = (table: string, extra = '') =>
    one(
      `SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1 AND brand_id = $2 ${extra}`,
    );
  return {
    decision: await scoped('decision'),
    moderationAction: await scoped('moderation_action'),
    policyEvaluation: await scoped('policy_evaluation'),
    otherJobs: await scoped('job_ledger', `AND job_type <> 'policy_preview'`),
  };
}
async function platformStates(t: Tenant): Promise<string[]> {
  const r = await db.c.query<{ platform_state: string }>(
    `SELECT platform_state FROM comment WHERE organization_id = $1 AND brand_id = $2 ORDER BY id`,
    [t.organizationId, t.brandId],
  );
  return r.rows.map((x) => x.platform_state);
}

describe('policy_preview (dry run)', () => {
  it('evaluates candidates, stores proposed actions and reasons, and changes nothing else', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    for (let i = 0; i < 3; i++) await candidate(t);
    const decided = await seedCommentRow(db.c, t, 'decided by a rule');
    await evaluateRulesFor(ruleEvaluations, decided, 'decided');
    const deleted = await seedCommentRow(db.c, t, 'deleted comment', { state: 'deleted' });
    await evaluateRulesFor(ruleEvaluations, deleted, 'no_match');
    const own = await seedCommentRow(db.c, t, 'our own reply', { own: true });
    await evaluateRulesFor(ruleEvaluations, own, 'no_match');
    await candidate(t, { ageDays: 10 });
    evaluator.evaluate.mockResolvedValue({ p1: 'clear_match' });
    const before = await counts(t);
    const statesBefore = await platformStates(t);

    const pv = await create(t);
    expect(pv).toMatchObject({ total: 3, capped: false });
    const result = await makeJob().handle(ctxFor(t, t.connectionId), {
      previewId: pv.id,
      chunk: 0,
    });

    expect(result).toEqual({ result: 'processed', count: 3 });
    const v = await previews.view(brandOf(t), pv.id);
    expect(v).toMatchObject({ status: 'done', examined: 3, matched: 3, errors: 0, notChecked: 0 });
    expect(
      v!.results.every(
        (r) => r.proposedAction === 'hide' && r.reason === 'Clear match: would hide.',
      ),
    ).toBe(true);
    expect(await counts(t)).toEqual(before);
    expect(await platformStates(t)).toEqual(statesBefore);
  });

  it('proposes flag for a possible match and says why', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    await candidate(t);
    evaluator.evaluate.mockResolvedValue({ p1: 'possible_match' });
    const pv = await create(t);
    await makeJob().handle(ctxFor(t, t.connectionId), { previewId: pv.id, chunk: 0 });
    const v = await previews.view(brandOf(t), pv.id);
    expect(v!.results[0]).toMatchObject({ verdict: 'possible_match', proposedAction: 'flag' });
    expect(v!.results[0]!.reason).toContain('instead of hide');
  });

  it('records no_match without a proposed action', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    await candidate(t);
    evaluator.evaluate.mockResolvedValue({ p1: 'no_match' });
    const pv = await create(t);
    await makeJob().handle(ctxFor(t, t.connectionId), { previewId: pv.id, chunk: 0 });
    const v = await previews.view(brandOf(t), pv.id);
    expect(v).toMatchObject({ examined: 1, matched: 0 });
    expect(v!.results[0]).toMatchObject({
      verdict: 'no_match',
      proposedAction: null,
      reason: null,
    });
  });

  it('caps at 200 comments and says so', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    for (let i = 0; i < 205; i++) await candidate(t);
    const pv = await create(t);
    expect(pv).toMatchObject({ total: 200, capped: true });
    expect(await previews.view(brandOf(t), pv.id)).toMatchObject({ total: 200, capped: true });
  });

  it('processes 10 per job and enqueues the next chunk for the same connection', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    for (let i = 0; i < 25; i++) await candidate(t);
    evaluator.evaluate.mockResolvedValue({ p1: 'no_match' });
    const pv = await create(t);
    const job = makeJob();
    const ctx = ctxFor(t, t.connectionId);

    await job.handle(ctx, { previewId: pv.id, chunk: 0 });
    expect(next).toHaveBeenLastCalledWith(ctx.scope, 'facebook', { previewId: pv.id, chunk: 1 });
    expect(await previews.view(brandOf(t), pv.id)).toMatchObject({
      status: 'running',
      examined: 10,
    });

    await job.handle(ctx, { previewId: pv.id, chunk: 1 });
    expect(next).toHaveBeenLastCalledWith(ctx.scope, 'facebook', { previewId: pv.id, chunk: 2 });

    next.mockClear();
    await job.handle(ctx, { previewId: pv.id, chunk: 2 });
    expect(next).not.toHaveBeenCalled();
    expect(await previews.view(brandOf(t), pv.id)).toMatchObject({ status: 'done', examined: 25 });
  });

  it('a retryable provider error retries the chunk and finished rows are not checked again', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    for (let i = 0; i < 3; i++) await candidate(t);
    evaluator.evaluate
      .mockResolvedValueOnce({ p1: 'no_match' })
      .mockResolvedValueOnce({ p1: 'no_match' })
      .mockRejectedValueOnce(new ClassifierProviderError('unavailable', true));
    const pv = await create(t);
    const job = makeJob();

    await expect(
      job.handle(ctxFor(t, t.connectionId, 1), { previewId: pv.id, chunk: 0 }),
    ).rejects.toMatchObject({ kind: 'retryable', code: 'policy_unavailable' });
    expect(await previews.view(brandOf(t), pv.id)).toMatchObject({ examined: 2, notChecked: 1 });

    evaluator.evaluate.mockResolvedValue({ p1: 'no_match' });
    await job.handle(ctxFor(t, t.connectionId, 2), { previewId: pv.id, chunk: 0 });
    expect(evaluator.evaluate).toHaveBeenCalledTimes(4);
    expect(await previews.view(brandOf(t), pv.id)).toMatchObject({ status: 'done', examined: 3 });
  });

  it('on the last attempt a failing comment is marked error and the preview continues', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    for (let i = 0; i < 2; i++) await candidate(t);
    evaluator.evaluate
      .mockRejectedValueOnce(new ClassifierProviderError('unavailable', true))
      .mockResolvedValueOnce({ p1: 'clear_match' });
    const pv = await create(t);
    await makeJob().handle(ctxFor(t, t.connectionId, 5), { previewId: pv.id, chunk: 0 });
    const v = await previews.view(brandOf(t), pv.id);
    expect(v).toMatchObject({ status: 'done', examined: 1, errors: 1, matched: 1 });
    expect(v!.results.find((r) => r.verdict === 'error')).toMatchObject({
      errorCode: 'unavailable',
    });
  });

  it('a non-retryable provider error is recorded on the comment straight away', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    await candidate(t);
    evaluator.evaluate.mockRejectedValue(new ClassifierProviderError('bad_request', false));
    const pv = await create(t);
    await makeJob().handle(ctxFor(t, t.connectionId, 1), { previewId: pv.id, chunk: 0 });
    expect(await previews.view(brandOf(t), pv.id)).toMatchObject({ status: 'done', errors: 1 });
  });

  it('does not count skipped rows as not checked', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    for (let i = 0; i < 2; i++) await candidate(t);
    evaluator.evaluate.mockResolvedValue({ p1: 'no_match' });
    const pv = await create(t);
    await db.c.query(
      `UPDATE comment SET platform_state = 'deleted'
        WHERE id = (SELECT comment_id FROM policy_preview_result WHERE preview_id = $1 LIMIT 1)`,
      [pv.id],
    );
    await makeJob().handle(ctxFor(t, t.connectionId), { previewId: pv.id, chunk: 0 });
    expect(await previews.view(brandOf(t), pv.id)).toMatchObject({ status: 'done', notChecked: 0 });
  });

  it('expires previews after the retention window', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    await candidate(t);
    const pv = await create(t);
    await db.c.query(
      `UPDATE policy_preview SET created_at = now() - interval '8 days' WHERE id = $1`,
      [pv.id],
    );
    expect(await previews.view(brandOf(t), pv.id)).toBeNull();
    expect(await previews.pruneExpired()).toBeGreaterThanOrEqual(1);
    const { rows } = await db.c.query(`SELECT 1 FROM policy_preview WHERE id = $1`, [pv.id]);
    expect(rows).toHaveLength(0);
  });

  it('stops with quota_exhausted when the monthly budget runs out', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    for (let i = 0; i < 3; i++) await candidate(t);
    evaluator.evaluate.mockResolvedValue({ p1: 'no_match' });
    const pv = await create(t);
    const r = await makeJob({ monthlyCallsPerBrand: 2 }).handle(ctxFor(t, t.connectionId), {
      previewId: pv.id,
      chunk: 0,
    });
    expect(r).toEqual({ result: 'stopped' });
    expect(await previews.view(brandOf(t), pv.id)).toMatchObject({
      status: 'done',
      stoppedReason: 'quota_exhausted',
      examined: 2,
      notChecked: 1,
    });
  });

  it('stops when the deployment has policy evaluation turned off', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    await candidate(t);
    evaluator.enabled = false;
    const pv = await create(t);
    await makeJob().handle(ctxFor(t, t.connectionId), { previewId: pv.id, chunk: 0 });
    expect(evaluator.evaluate).not.toHaveBeenCalled();
    expect(await previews.view(brandOf(t), pv.id)).toMatchObject({
      status: 'done',
      stoppedReason: 'evaluator_disabled',
    });
  });

  it('allows one running preview per brand', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    await create(t);
    await expect(create(t)).rejects.toBeInstanceOf(PreviewInProgressError);
  });

  it('prunes previews older than 7 days when a new one is created', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    const old = await db.c.query<{ id: string }>(
      `INSERT INTO policy_preview
         (organization_id, brand_id, text, action, days, since, total, capped, status, completed_at, created_at)
       VALUES ($1, $2, $3, 'flag', 7, now(), 0, false, 'done', now(), now() - interval '8 days')
       RETURNING id`,
      [t.organizationId, t.brandId, draft.text],
    );
    await create(t);
    expect(await previews.load(brandOf(t), old.rows[0]!.id)).toBeNull();
  });

  it('replaces a running preview whose jobs were lost', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    const stale = await create(t);
    await db.c.query(
      `UPDATE policy_preview SET created_at = now() - interval '3 hours' WHERE id = $1`,
      [stale.id],
    );
    const fresh = await create(t);
    expect(await previews.load(brandOf(t), stale.id)).toBeNull();
    expect(await previews.load(brandOf(t), fresh.id)).toMatchObject({ status: 'running' });
  });

  it('withdraw removes the preview and frees the brand for the next one', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    const pv = await create(t);
    await previews.withdraw(brandOf(t), pv.id);
    expect(await previews.load(brandOf(t), pv.id)).toBeNull();
    await expect(create(t)).resolves.toBeDefined();
  });

  it('only processes rows of the connection the job runs for', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    const b = await secondConnection(t);
    await candidate(t);
    await candidate(t);
    await candidate(b);
    await candidate(b);
    evaluator.evaluate.mockResolvedValue({ p1: 'no_match' });
    const pv = await create(t);
    expect(pv.connections.map((c) => c.connectionId).sort()).toEqual(
      [t.connectionId, b.connectionId].sort(),
    );

    await makeJob().handle(ctxFor(t, b.connectionId), { previewId: pv.id, chunk: 0 });

    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(await previews.view(brandOf(t), pv.id)).toMatchObject({
      status: 'running',
      examined: 2,
      notChecked: 2,
    });
    const pending = await previews.pending(scopeOf(t), pv.id, 10);
    expect(pending).toHaveLength(2);
  });

  it('does not show a preview to another brand', async () => {
    const t = await seedTenant(db.c, `pv${++n}`);
    const other = await seedTenant(db.c, `pv${++n}`);
    const pv = await create(t);
    expect(await previews.load(brandOf(other), pv.id)).toBeNull();
    expect(await previews.view(brandOf(other), pv.id)).toBeNull();
    const r = await makeJob().handle(ctxFor(other, other.connectionId), {
      previewId: pv.id,
      chunk: 0,
    });
    expect(r).toEqual({ result: 'gone' });
  });
});
