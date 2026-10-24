import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PgJobLedger,
  deriveIdempotencyKey,
  type EnqueueRequest,
  type EnqueueResult,
} from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { TIKTOK_ADS_POLL_JOB, TIKTOK_POLL_JOB } from '../jobs/specs.js';
import { TikTokPollScheduler, type TikTokSchedulerDeps } from './scheduler.js';
import { tiktokWorld, type TikTokWorld } from './test-world.js';

let w: TikTokWorld;
beforeAll(async () => {
  w = await tiktokWorld('scheduler');
});
afterAll(() => w.close());

const intervals = { tiktok: 300, tiktok_ads: 600 };

// The real ledger, so the (organization_id, idempotency_key) uniqueness is what deduplicates.
function producer(): TikTokSchedulerDeps['producer'] {
  const ledger = new PgJobLedger(w.pool);
  return {
    enqueue: async (req: EnqueueRequest): Promise<EnqueueResult> => {
      const key = deriveIdempotencyKey({
        scope: req.scope,
        platform: req.platform,
        type: req.type,
        callerKey: req.idempotencyKey!,
      });
      const r = await ledger.insert({
        scope: req.scope,
        platform: req.platform,
        jobType: req.type,
        idempotencyKey: key,
        payloadJson: JSON.stringify(req.payload),
        ttlMs: 86_400_000,
        traceContext: null,
      });
      if (r.status === 'no_connection') throw new Error('connection_not_found');
      return r.status === 'inserted'
        ? { status: 'enqueued', ledgerId: r.id, jobId: key }
        : { status: 'deduplicated', ledgerId: r.id, jobId: key, state: r.state };
    },
  };
}

const scheduler = (o: Partial<TikTokSchedulerDeps> = {}) =>
  new TikTokPollScheduler({
    polling: w.polling,
    producer: producer(),
    clock: w.now,
    platforms: ['tiktok', 'tiktok_ads'],
    tickSec: 30,
    maxConnectionsPerTick: 100,
    intervals,
    log: { warn: () => {} },
    ...o,
  });

const ledgerRows = async (scopes: ConnectionScope[]) =>
  (
    await w.pool.query<{ connection_id: string; job_type: string; idempotency_key: string }>(
      `SELECT connection_id, job_type, idempotency_key FROM job_ledger
        WHERE connection_id = ANY($1::uuid[]) ORDER BY connection_id, job_type`,
      [scopes.map((s) => s.connectionId)],
    )
  ).rows;

describe('TikTokPollScheduler', () => {
  it('enqueues one job per due connection per bucket; a second tick in the same bucket enqueues nothing new', async () => {
    w.reset();
    const t = await w.tenant('bucket');
    const organic = await w.insertConnection(t, 'tiktok', 'tt-bucket', 'tok');
    const ads = await w.insertConnection(t, 'tiktok_ads', '7001', 'tok');
    const s = scheduler();
    const first = await s.tick();
    expect(first.enqueued).toBeGreaterThanOrEqual(2);
    expect(await s.tick()).toEqual({ enqueued: 0 });
    const rows = await ledgerRows([organic, ads]);
    expect(rows.map((r) => r.job_type).sort()).toEqual(
      [TIKTOK_ADS_POLL_JOB.type, TIKTOK_POLL_JOB.type].sort(),
    );

    w.advance(intervals.tiktok_ads * 1000);
    await s.tick();
    expect(await ledgerRows([organic, ads])).toHaveLength(4);
  });

  it('two schedulers ticking concurrently produce one ledger row per connection per bucket', async () => {
    w.reset();
    const t = await w.tenant('concurrent');
    const conns = await Promise.all(
      [1, 2, 3, 4].map((i) => w.insertConnection(t, 'tiktok', `tt-conc-${i}`, 'tok')),
    );
    await Promise.all([scheduler().tick(), scheduler().tick(), scheduler().tick()]);
    const rows = await ledgerRows(conns);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.connection_id)).size).toBe(4);
  });

  it('revoked, paused and reconnect_required connections are never enqueued', async () => {
    w.reset();
    const t = await w.tenant('inactive');
    const active = await w.insertConnection(t, 'tiktok', 'tt-in-1', 'tok');
    const others = await Promise.all(
      ['revoked', 'paused', 'reconnect_required'].map((st, i) =>
        w.insertConnection(t, 'tiktok', `tt-in-x${i}`, 'tok', st),
      ),
    );
    const adsOthers = await Promise.all(
      ['revoked', 'paused', 'reconnect_required'].map((st, i) =>
        w.insertConnection(t, 'tiktok_ads', `70${i}`, 'tok', st),
      ),
    );
    await scheduler().tick();
    expect((await ledgerRows([active])).length).toBe(1);
    expect(await ledgerRows([...others, ...adsOthers])).toEqual([]);
  });

  it('tiktok_ads-only deployment schedules only tiktok_ads', async () => {
    w.reset();
    const t = await w.tenant('adsonly');
    const organic = await w.insertConnection(t, 'tiktok', 'tt-ao', 'tok');
    const ads = await w.insertConnection(t, 'tiktok_ads', '7100', 'tok');
    await scheduler({ platforms: ['tiktok_ads'] }).tick();
    expect(await ledgerRows([organic])).toEqual([]);
    expect((await ledgerRows([ads])).map((r) => r.job_type)).toEqual([TIKTOK_ADS_POLL_JOB.type]);
  });

  it('uses <job>:<floor(now / interval)> as the idempotency key', async () => {
    w.reset();
    const t = await w.tenant('key');
    const c = await w.insertConnection(t, 'tiktok', 'tt-key', 'tok');
    const seen: EnqueueRequest[] = [];
    await scheduler({
      platforms: ['tiktok'],
      producer: {
        enqueue: async (req) => {
          if (req.scope.connectionId === c.connectionId) seen.push(req);
          return { status: 'enqueued', ledgerId: 'l', jobId: 'j' };
        },
      },
    }).tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      platform: 'tiktok',
      type: TIKTOK_POLL_JOB.type,
      payload: { connectionId: c.connectionId },
      idempotencyKey: `tiktok_poll:${Math.floor(w.clock.now() / 1000 / intervals.tiktok)}`,
    });
  });

  it('a failed enqueue is logged and the rest of the tick continues', async () => {
    w.reset();
    const t = await w.tenant('fail');
    const bad = await w.insertConnection(t, 'tiktok', 'tt-f1', 'tok');
    const good = await w.insertConnection(t, 'tiktok', 'tt-f2', 'tok');
    const warnings: string[] = [];
    const real = producer();
    const r = await scheduler({
      platforms: ['tiktok'],
      log: { warn: (m) => void warnings.push(m) },
      producer: {
        enqueue: (req) =>
          req.scope.connectionId === bad.connectionId
            ? Promise.reject(new Error('redis down'))
            : real.enqueue(req),
      },
    }).tick();
    expect(r.enqueued).toBeGreaterThanOrEqual(1);
    expect(warnings).toContain('tiktok_scheduler.enqueue_failed');
    expect(await ledgerRows([good])).toHaveLength(1);
  });
});
