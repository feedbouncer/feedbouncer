import type { Pool } from 'pg';
import type { Logger } from '@feedbouncer/service-runtime';
import type { ScanSettings } from '../config.js';
import { STALE_RUNNING_MS } from '../limits.js';
import type { PgScanStore } from '../pg/store.js';
import { enqueueScan, type ScanQueue } from './transport.js';

const LOCK = 'fb.scan_maintenance';
const REQUEUE_AFTER_MS = 120_000;

/**
 * Times out scans a crashed worker left running, re-enqueues scans whose job was lost
 * (the job id makes this idempotent) and purges scans past retention. Replicas take
 * turns through a session advisory lock; a run that finds it held does nothing.
 */
export async function runScanMaintenance(d: {
  pool: Pool;
  store: PgScanStore;
  queue: ScanQueue;
  settings: ScanSettings;
  now: () => Date;
  log: Logger;
}): Promise<void> {
  const client = await d.pool.connect();
  let broken = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [LOCK],
    );
    if (!rows[0]?.locked) return;
    try {
      const timedOut = await d.store.failStale(d.now(), STALE_RUNNING_MS);
      const queued = await d.store.queuedOlderThan(d.now(), REQUEUE_AFTER_MS);
      for (const id of queued) await enqueueScan(d.queue, id);
      const purged = await d.store.purge(d.now(), d.settings.retentionDays);
      d.log.info('scan.maintenance', { timedOut, requeued: queued.length, ...purged });
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK]).catch(() => {
        broken = true;
      });
    }
  } finally {
    client.release(broken);
  }
}
