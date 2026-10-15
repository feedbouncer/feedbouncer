// policy_run over real Postgres: the run row, candidate selection by connection
// and window, and the evaluate jobs it enqueues (recorded, not executed).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool, withTransaction } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { JobProducer } from '@feedbouncer/jobs';
import { PgEvaluationStore, bodySha256 } from '@feedbouncer/rules';
import { createLogger } from '@feedbouncer/service-runtime';
import {
  evaluateRulesFor,
  fakeJobContext,
  seedCommentRow,
  type Seeded,
} from '@feedbouncer/classifier/testing';
import { PgPolicyStore, type StoredPolicy } from '../store.js';
import { RUN_MAX_COMMENTS_PER_CONNECTION } from '../types.js';
import { policyRunJob } from './run.js';
import { POLICY_RUN_JOB } from './specs.js';

const quiet = createLogger('policy-run-test', 'error', () => {});

let db: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let ruleEvaluations: PgEvaluationStore;
let policies: PgPolicyStore;
let enqueue: ReturnType<typeof vi.fn<JobProducer['enqueue']>>;
let n = 0;

beforeAll(async () => {
  db = await migratedDb();
  pool = createPool(db.db.url, { applicationName: 'policy-run-test', onIdleError: () => {} });
  ruleEvaluations = new PgEvaluationStore(pool);
  policies = new PgPolicyStore(pool);
});
afterAll(async () => {
  await pool.end();
  await db.close();
});
beforeEach(() => {
  enqueue = vi.fn(async () => ({}) as never);
});

const brandOf = (t: Tenant) => ({ organizationId: t.organizationId, brandId: t.brandId });
const makeJob = (maxComments = RUN_MAX_COMMENTS_PER_CONNECTION) =>
  policyRunJob({
    pool,
    producer: { enqueue },
    clock: { now: () => 1_700_000_000_000 },
    maxComments,
  });
const ctxFor = (t: Tenant, connectionId = t.connectionId) =>
  fakeJobContext(t, 1, POLICY_RUN_JOB.type, quiet, connectionId);

async function tenantWithPolicy(): Promise<{ t: Tenant; policy: StoredPolicy }> {
  const t = await seedTenant(db.c, `run${++n}`);
  const policy = await withTransaction(pool, (c) =>
    policies.create(
      c,
      brandOf(t),
      {
        name: 'No DMs',
        text: 'Comments asking people to DM another account',
        action: 'hide',
      },
      t.userId,
    ),
  );
  return { t, policy };
}
const startRun = (t: Tenant, p: StoredPolicy, days = 7) =>
  withTransaction(pool, (c) =>
    policies.insertRun(c, brandOf(t), {
      policyId: p.id,
      revisionId: p.revisionId,
      days,
      userId: t.userId,
    }),
  );
async function startedRunId(t: Tenant, p: StoredPolicy): Promise<string> {
  const r = await startRun(t, p);
  if (r === 'too_soon') throw new Error('run not started');
  return r.id;
}

async function candidate(t: Tenant, o: { ageDays?: number } = {}): Promise<Seeded> {
  const c = await seedCommentRow(db.c, t, `dm my other account ${++n}`);
  if (o.ageDays)
    await db.c.query(
      `UPDATE comment SET posted_at = now() - make_interval(days => $2) WHERE id = $1`,
      [c.id, o.ageDays],
    );
  await evaluateRulesFor(ruleEvaluations, c, 'no_match');
  return c;
}
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

describe('policy_run', () => {
  it('enqueues policy_evaluate with the run trigger for this connection’s undecided comments in the window', async () => {
    const { t, policy } = await tenantWithPolicy();
    const b = await secondConnection(t);
    const eligible = [await candidate(t), await candidate(t), await candidate(t)];
    const decided = await seedCommentRow(db.c, t, 'decided by a rule');
    await evaluateRulesFor(ruleEvaluations, decided, 'decided');
    const deleted = await seedCommentRow(db.c, t, 'deleted', { state: 'deleted' });
    await evaluateRulesFor(ruleEvaluations, deleted, 'no_match');
    await candidate(t, { ageDays: 10 });
    await candidate(b);
    const runId = await startedRunId(t, policy);

    const r = await makeJob().handle(ctxFor(t), { runId });

    expect(r).toEqual({ result: 'enqueued', count: 3 });
    expect(enqueue).toHaveBeenCalledTimes(3);
    const requests = enqueue.mock.calls.map(([req]) => req);
    expect(requests.every((q) => q.type === 'policy_evaluate')).toBe(true);
    expect(requests.every((q) => q.scope.connectionId === t.connectionId)).toBe(true);
    expect(requests.map((q) => q.payload)).toEqual(
      eligible
        .map((c) => ({
          commentId: c.id,
          bodySha256: bodySha256(c.body),
          trigger: `run:${runId}`,
          requestedAt: 1_700_000_000_000,
        }))
        .reverse(),
    );
  });

  it('enqueues at most maxComments, newest first', async () => {
    const { t, policy } = await tenantWithPolicy();
    await candidate(t, { ageDays: 3 });
    const newest = await candidate(t, { ageDays: 1 });
    const middle = await candidate(t, { ageDays: 2 });
    const runId = await startedRunId(t, policy);

    const r = await makeJob(2).handle(ctxFor(t), { runId });

    expect(r).toEqual({ result: 'enqueued', count: 2 });
    expect(enqueue.mock.calls.map(([q]) => (q.payload as { commentId: string }).commentId)).toEqual(
      [newest.id, middle.id],
    );
  });

  it('enqueues nothing for a run of another brand or a missing run', async () => {
    const mine = await tenantWithPolicy();
    const theirs = await tenantWithPolicy();
    await candidate(mine.t);
    const theirRun = await startedRunId(theirs.t, theirs.policy);

    expect(await makeJob().handle(ctxFor(mine.t), { runId: theirRun })).toEqual({ result: 'gone' });
    expect(
      await makeJob().handle(ctxFor(mine.t), { runId: '00000000-0000-4000-8000-000000000000' }),
    ).toEqual({ result: 'gone' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('PgPolicyStore runs', () => {
  it('refuses a second run within 15 minutes for the brand', async () => {
    const { t, policy } = await tenantWithPolicy();
    expect(await startRun(t, policy)).toEqual({ id: expect.any(String) });
    expect(await startRun(t, policy)).toBe('too_soon');
  });

  it('allows a run again once the interval has passed', async () => {
    const { t, policy } = await tenantWithPolicy();
    await startedRunId(t, policy);
    await db.c.query(
      `UPDATE policy_run SET created_at = now() - interval '16 minutes' WHERE organization_id = $1 AND brand_id = $2`,
      [t.organizationId, t.brandId],
    );
    expect(await startRun(t, policy)).toEqual({ id: expect.any(String) });
  });

  it('does not let another brand’s run block this brand', async () => {
    const a = await tenantWithPolicy();
    const b = await tenantWithPolicy();
    await startedRunId(a.t, a.policy);
    expect(await startRun(b.t, b.policy)).toEqual({ id: expect.any(String) });
  });

  it('lists only the brand’s active connections', async () => {
    const t = await seedTenant(db.c, `run${++n}`);
    const b = await secondConnection(t);
    await db.c.query(`UPDATE connection SET status = 'paused' WHERE id = $1`, [b.connectionId]);
    const other = await seedTenant(db.c, `run${++n}`);

    expect(await policies.activeConnections(brandOf(t))).toEqual([
      { connectionId: t.connectionId, platform: 'facebook' },
    ]);
    expect(await policies.activeConnections(brandOf(other))).not.toContainEqual(
      expect.objectContaining({ connectionId: t.connectionId }),
    );
  });
});
