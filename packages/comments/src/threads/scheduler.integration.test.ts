import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PgJobLedger,
  deriveIdempotencyKey,
  type EnqueueRequest,
  type EnqueueResult,
} from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { THREADS_POLL_JOB } from '../jobs/specs.js';
import { ThreadsPollScheduler } from './scheduler.js';
import { log, threadsWorld, type ThreadsWorld } from './test-world.js';

let w: ThreadsWorld;
beforeAll(async () => {
  w = await threadsWorld('scheduler');
});
afterAll(() => w.close());

// The real ledger, so the (organization_id, idempotency_key) uniqueness is what deduplicates.
function producer() {
  const ledger = new PgJobLedger(w.pool);
  return {
    enqueue: async (req: EnqueueRequest): Promise<EnqueueResult> => {
      const payload = req.payload as { bucket: number };
      const key = deriveIdempotencyKey({
        scope: req.scope,
        platform: req.platform,
        type: req.type,
        externalRef: THREADS_POLL_JOB.externalRef(payload),
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

const scheduler = () =>
  new ThreadsPollScheduler({ polling: w.polling, producer: producer(), clock: w.clock, log });

const ledgerRows = async (scopes: ConnectionScope[]) =>
  (
    await w.pool.query<{ connection_id: string; job_type: string; payload: { bucket: number } }>(
      `SELECT connection_id, job_type, payload FROM job_ledger
        WHERE connection_id = ANY($1::uuid[]) ORDER BY connection_id`,
      [scopes.map((s) => s.connectionId)],
    )
  ).rows;

describe('ThreadsPollScheduler', () => {
  it('two ticks in the same 5 s bucket enqueue once per connection', async () => {
    const t = await w.tenant('bucket');
    const a = await w.insertConnection(t, 'u-bucket-1');
    const b = await w.insertConnection(t, 'u-bucket-2');
    const s = scheduler();
    expect((await s.tick()).enqueued).toBeGreaterThanOrEqual(2);
    expect(await s.tick()).toEqual({ enqueued: 0 });
    const rows = await ledgerRows([a, b]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.job_type === 'threads_poll')).toBe(true);
    expect(rows[0]!.payload.bucket).toBe(Math.floor(w.clock.now() / 1000 / 5));

    w.advance(5_000);
    await s.tick();
    expect(await ledgerRows([a, b])).toHaveLength(4);
  });

  it('a reconnect_required connection is not enqueued', async () => {
    const t = await w.tenant('inactive');
    const active = await w.insertConnection(t, 'u-in-1');
    const stale = await w.insertConnection(t, 'u-in-2', 'reconnect_required');
    await scheduler().tick();
    expect(await ledgerRows([active])).toHaveLength(1);
    expect(await ledgerRows([stale])).toEqual([]);
  });
});
