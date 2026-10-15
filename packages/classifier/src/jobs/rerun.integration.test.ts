// classifier_rerun over real Postgres: selects this connection's live, non-deleted,
// non-own comments since the run's window and enqueues one comment_classify each.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { JobContext } from '@feedbouncer/jobs';
import { bodySha256 } from '@feedbouncer/rules';
import { createLogger } from '@feedbouncer/service-runtime';
import { classifierRerunJob } from './rerun.js';
import { CLASSIFIER_RERUN_JOB } from './specs.js';

const quiet = createLogger('rerun-test', 'error', () => {});

let ctxDb: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let producer: { enqueue: ReturnType<typeof vi.fn> };
let n = 0;

beforeAll(async () => {
  ctxDb = await migratedDb();
  pool = createPool(ctxDb.db.url, { applicationName: 'rerun-test', onIdleError: () => {} });
});
afterAll(async () => {
  await pool.end();
  await ctxDb.close();
});
beforeEach(() => {
  producer = { enqueue: vi.fn().mockResolvedValue(undefined) };
});

const tenant = () => seedTenant(ctxDb.c, `rrj${++n}`);
const job = (o: { maxComments?: number; clock?: { now(): number } } = {}) =>
  classifierRerunJob({
    pool,
    producer: producer as never,
    log: quiet,
    clock: { now: () => 1_700_000_000_000 },
    ...o,
  });
const ctx = (t: Tenant): JobContext => ({
  scope: { organizationId: t.organizationId, brandId: t.brandId, connectionId: t.connectionId },
  platform: 'facebook',
  jobType: CLASSIFIER_RERUN_JOB.type,
  ledgerId: randomUUID(),
  attempt: 1,
  isReplay: false,
  signal: new AbortController().signal,
  log: quiet,
});

async function seedRun(t: Tenant): Promise<string> {
  const r = await ctxDb.c.query<{ id: string }>(
    `INSERT INTO classifier_run (organization_id, brand_id, requested_by_user_id, days, since)
     VALUES ($1, $2, $3, 7, now() - interval '7 days') RETURNING id`,
    [t.organizationId, t.brandId, t.userId],
  );
  return r.rows[0]!.id;
}

async function seedComment(
  t: Tenant,
  o: { state?: string; own?: boolean; origin?: string; ageMs?: number } = {},
): Promise<{ id: string; body: string }> {
  const body = `body ${randomUUID()}`;
  const r = await ctxDb.c.query<{ id: string }>(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, platform_state,
       is_own_account, ingest_origin, posted_at, ingested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now() - ($10 || ' milliseconds')::interval) RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      t.connectionId,
      t.sourceId,
      `ext-${randomUUID()}`,
      body,
      o.state ?? 'visible',
      o.own ?? false,
      o.origin ?? 'live',
      String(o.ageMs ?? 1000),
    ],
  );
  return { id: r.rows[0]!.id, body };
}

describe('classifier_rerun', () => {
  it('enqueues one comment_classify per live, non-deleted, non-own comment of this connection in the run window', async () => {
    const a = await tenant();
    const b = await tenant();
    const keep = [await seedComment(a), await seedComment(a), await seedComment(a)];
    await seedComment(a, { state: 'deleted' });
    await seedComment(a, { own: true });
    await seedComment(a, { origin: 'backfill' });
    await seedComment(a, { ageMs: 2 * 3_600_000 });
    await seedComment(b);
    const runId = await seedRun(a);
    await ctxDb.c.query(
      `UPDATE classifier_run SET since = now() - interval '1 hour' WHERE id = $1`,
      [runId],
    );
    const r = await job().handle(ctx(a), { runId });
    expect(r).toEqual({ enqueued: 3, capped: false });
    const calls = producer.enqueue.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.payload.trigger)).toEqual(Array(3).fill(`rerun:${runId}`));
    expect(
      calls.every((c) => c.type === 'comment_classify' && c.scope.connectionId === a.connectionId),
    ).toBe(true);
    expect(calls.map((c) => c.payload.commentId).sort()).toEqual(keep.map((k) => k.id).sort());
    for (const k of keep)
      expect(calls.find((c) => c.payload.commentId === k.id).payload.bodySha256).toBe(
        bodySha256(k.body),
      );
  });

  it('refuses a run id that belongs to another brand (no enqueue)', async () => {
    const a = await tenant();
    const b = await tenant();
    await seedComment(b);
    const runId = await seedRun(a);
    expect(await job().handle(ctx(b), { runId })).toEqual({ result: 'gone' });
    expect(producer.enqueue).not.toHaveBeenCalled();
  });

  it('caps at the maximum and reports it', async () => {
    const a = await tenant();
    for (let i = 0; i < 5; i++) await seedComment(a);
    const runId = await seedRun(a);
    const r = await job({ maxComments: 4 }).handle(ctx(a), { runId });
    expect(r).toEqual({ enqueued: 4, capped: true });
    expect(producer.enqueue).toHaveBeenCalledTimes(4);
  });

  it('a repeated run enqueues identical comment/body/trigger args, so the ledger can dedup them', async () => {
    const a = await tenant();
    await seedComment(a);
    await seedComment(a);
    const runId = await seedRun(a);
    const p = { runId };
    await job().handle(ctx(a), p);
    await job().handle(ctx(a), p);
    const refs = (i: number) =>
      producer.enqueue.mock.calls
        .slice(i * 2, i * 2 + 2)
        .map((c) => `${c[0].payload.commentId}:${c[0].payload.bodySha256}:${c[0].payload.trigger}`)
        .sort();
    expect(refs(0)).toEqual(refs(1));
    expect(producer.enqueue).toHaveBeenCalledTimes(4);
  });

  it('never reaches back more than 30 days even if the run row says so', async () => {
    const a = await tenant();
    const recent = await seedComment(a);
    await seedComment(a, { ageMs: 40 * 86_400_000 });
    const runId = await seedRun(a);
    await ctxDb.c.query(
      `UPDATE classifier_run SET since = now() - interval '60 days' WHERE id = $1`,
      [runId],
    );
    const r = await job({ clock: { now: () => Date.now() } }).handle(ctx(a), { runId });
    expect(r).toEqual({ enqueued: 1, capped: false });
    expect(producer.enqueue.mock.calls[0]![0].payload.commentId).toBe(recent.id);
  });

  it('exactly the maximum is not reported as capped', async () => {
    const a = await tenant();
    for (let i = 0; i < 4; i++) await seedComment(a);
    const runId = await seedRun(a);
    const r = await job({ maxComments: 4 }).handle(ctx(a), { runId });
    expect(r).toEqual({ enqueued: 4, capped: false });
  });
});
