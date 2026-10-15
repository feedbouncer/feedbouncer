import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import { PgBackfillStore } from './store.js';
import { BACKFILL_DEFAULTS } from './settings.js';

const DAY = 86_400_000;
const T0 = new Date('2026-10-14T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const runOf = (r: Awaited<ReturnType<PgBackfillStore['request']>>) => {
  if (r.kind === 'up_to_date') throw new Error('expected a run');
  return r.runId;
};

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgBackfillStore;
let scope: Tenant;
let n = 0;
beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'backfill-store-test', onIdleError: () => {} });
  store = new PgBackfillStore(pool, BACKFILL_DEFAULTS);
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(async () => {
  scope = await seedTenant(ctx.c, `bf${++n}`);
});

const audit = (action: string, when: Date) =>
  pool.query(
    `INSERT INTO audit_event (organization_id, brand_id, actor_type, action, subject_type, subject_id, created_at)
     VALUES ($1, $2, 'system', $3, 'connection', $4, $5)`,
    [scope.organizationId, scope.brandId, action, scope.connectionId, when],
  );
const emptyCheckpoint = {
  sourceCursor: null,
  sourcesExhausted: false,
  sourceQueue: [],
  commentCursor: null,
  importedDelta: 0,
  sourcesDoneDelta: 0,
};

describe('PgBackfillStore', () => {
  it('first request starts a 30-day run', async () => {
    const r = await store.request(scope, T0);
    expect(r).toMatchObject({ kind: 'started', segment: 0 });
    const run = await store.claim(scope, runOf(r), 0, T0);
    expect(run!.windowStart).toEqual(at(-30 * DAY));
    expect(run!.windowEnd).toEqual(T0);
    expect(run!.status).toBe('running');
    expect(run!.maxComments).toBe(BACKFILL_DEFAULTS.maxComments);
  });

  it('request() returns the running run unchanged (duplicate connect)', async () => {
    const runId = runOf(await store.request(scope, T0));
    for (let seg = 0; seg <= 3; seg++) await store.claim(scope, runId, seg, at(seg * 1000));
    await store.checkpoint(
      scope,
      runId,
      { ...emptyCheckpoint, sourceCursor: 'a:x', sourceQueue: ['1_2'], importedDelta: 7 },
      at(3500),
    );
    expect(await store.request(scope, at(4000))).toEqual({ kind: 'existing', runId, segment: 3 });
    const r = await pool.query(
      `SELECT imported_count, source_cursor FROM connection_backfill WHERE connection_id = $1`,
      [scope.connectionId],
    );
    expect(r.rows[0]).toEqual({ imported_count: 7, source_cursor: 'a:x' });
  });

  it('claim accepts the current or next segment only, and rejects other runs', async () => {
    const runId = runOf(await store.request(scope, T0));
    expect(await store.claim(scope, runId, 1, T0)).not.toBeNull();
    expect(await store.claim(scope, runId, 0, T0)).toBeNull();
    expect(await store.claim(scope, runId, 3, T0)).toBeNull();
    expect(await store.claim(scope, '00000000-0000-4000-8000-000000000000', 1, T0)).toBeNull();
  });

  it('checkpoint returns false after cancel, and nothing else moves', async () => {
    const runId = runOf(await store.request(scope, T0));
    await store.claim(scope, runId, 0, T0);
    await store.cancel(scope, at(1));
    const moved = await store.checkpoint(
      scope,
      runId,
      { ...emptyCheckpoint, sourceCursor: 'a:x', sourceQueue: ['1_2'], importedDelta: 5 },
      at(2),
    );
    expect(moved).toBe(false);
    expect((await store.views(scope, at(3))).get(scope.connectionId)).toMatchObject({
      status: 'failed',
      failureReason: 'cancelled',
      importedCount: 0,
    });
    expect(await store.claim(scope, runId, 0, at(4))).toBeNull();
  });

  it('records at most maxSkippedRecorded skipped sources but counts all', async () => {
    const runId = runOf(await store.request(scope, T0));
    await store.claim(scope, runId, 0, T0);
    for (let i = 0; i < 60; i++)
      await store.checkpoint(
        scope,
        runId,
        {
          ...emptyCheckpoint,
          sourcesDoneDelta: 1,
          skipped: { source: `1_${i}`, code: 'source_inaccessible' },
        },
        T0,
      );
    const r = await pool.query(
      `SELECT skipped_count, jsonb_array_length(skipped_sources) AS n FROM connection_backfill WHERE connection_id = $1`,
      [scope.connectionId],
    );
    expect(r.rows[0]).toEqual({ skipped_count: 60, n: 50 });
  });

  it('after completion with no outage, reconnect is up_to_date', async () => {
    const runId = runOf(await store.request(scope, T0));
    await store.claim(scope, runId, 0, T0);
    await store.complete(scope, runId, { limited: false }, at(60_000));
    expect(await store.request(scope, at(5 * DAY))).toEqual({ kind: 'up_to_date' });
  });

  it('reconnect after completion fetches only the outage gap (less overlap)', async () => {
    const runId = runOf(await store.request(scope, T0));
    await store.claim(scope, runId, 0, T0);
    await store.complete(scope, runId, { limited: false }, at(60_000));
    await audit('connection.reconnect_required', at(10 * DAY));
    await audit('connection.reconnect_required', at(11 * DAY));
    const r2 = runOf(await store.request(scope, at(12 * DAY)));
    const run = await store.claim(scope, r2, 0, at(12 * DAY));
    expect(run!.windowStart).toEqual(at(10 * DAY - BACKFILL_DEFAULTS.gapOverlapMs));
    expect(run!.windowEnd).toEqual(at(12 * DAY));
    expect(run!.importedCount).toBe(0);
  });

  it('gap is clamped to the 30-day window', async () => {
    const runId = runOf(await store.request(scope, T0));
    await store.claim(scope, runId, 0, T0);
    await store.complete(scope, runId, { limited: false }, at(1));
    await audit('connection.disconnected', at(DAY));
    const now = at(90 * DAY);
    const run = await store.claim(scope, runOf(await store.request(scope, now)), 0, now);
    expect(run!.windowStart).toEqual(new Date(now.getTime() - 30 * DAY));
  });

  it('failed run without any completion restarts the full window', async () => {
    const runId = runOf(await store.request(scope, T0));
    await store.claim(scope, runId, 0, T0);
    await store.fail(scope, runId, 'reconnect_required', at(1));
    const r = await store.request(scope, at(DAY));
    expect(r.kind).toBe('started');
    expect(runOf(r)).not.toBe(runId);
    const run = await store.claim(scope, runOf(r), 0, at(DAY));
    expect(run!.windowStart).toEqual(at(DAY - 30 * DAY));
  });

  it('stale running row is replaced and shown as failed/stalled', async () => {
    const runId = runOf(await store.request(scope, T0));
    await store.claim(scope, runId, 0, T0);
    const later = at(BACKFILL_DEFAULTS.staleAfterMs + 1);
    expect((await store.views(scope, later)).get(scope.connectionId)).toMatchObject({
      status: 'failed',
      failureReason: 'stalled',
    });
    const r = await store.request(scope, later);
    expect(r.kind).toBe('started');
    expect(runOf(r)).not.toBe(runId);
  });

  it('views never leak another brand', async () => {
    await store.request(scope, T0);
    const other = await seedTenant(ctx.c, `bf-other-${n}`);
    expect((await store.views(other, T0)).size).toBe(0);
  });

  it('completed view reports limited', async () => {
    const runId = runOf(await store.request(scope, T0));
    await store.claim(scope, runId, 0, T0);
    await store.complete(scope, runId, { limited: true }, at(1));
    expect((await store.views(scope, at(2))).get(scope.connectionId)).toMatchObject({
      status: 'completed',
      limitedTo: BACKFILL_DEFAULTS.maxComments,
      completedAt: at(1),
    });
  });

  it('request() for another tenant never touches this connection', async () => {
    const runId = runOf(await store.request(scope, T0));
    await store.claim(scope, runId, 0, T0);
    const wrong = {
      ...scope,
      organizationId: (await seedTenant(ctx.c, `bf-x-${n}`)).organizationId,
    };
    await expect(store.request(wrong, T0)).rejects.toThrow('backfill_connection_not_found');
    expect(await store.cancel(wrong, at(1))).toBeUndefined();
    expect(await store.claim(scope, runId, 0, at(2))).not.toBeNull();
  });
});
