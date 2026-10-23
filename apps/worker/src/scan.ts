import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { createPool } from '@feedbouncer/db';
import type { FbMetrics } from '@feedbouncer/observability';
import {
  SCAN_QUEUE,
  runScan,
  runScanMaintenance,
  scanJobPayload,
  type PgScanStore,
  type ScanMetrics,
  type ScanRunnerDeps,
  type ScanSettings,
} from '@feedbouncer/scan';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import { every } from './interval.js';

const MAINTENANCE_INTERVAL_MS = 300_000;

export function promScanMetrics(m: FbMetrics): ScanMetrics {
  return {
    finished({ status, reason, durationSec, commentsScanned }) {
      m.scanFinished.inc({ status, reason: reason ?? 'none' });
      m.scanDuration.observe(durationSec);
      if (commentsScanned !== null) m.scanCommentsScanned.observe(commentsScanned);
    },
  };
}

/** Consumes the scan queue, which carries scan ids only; the sealed token stays in Postgres. */
export function startScanWorker(d: {
  connection: Redis;
  prefix: string;
  concurrency: number;
  deps: ScanRunnerDeps;
  log: Logger;
}): { close(): Promise<void> } {
  const worker = new Worker(
    SCAN_QUEUE,
    (job: Job) => {
      const parsed = scanJobPayload.safeParse(job.data);
      if (!parsed.success) throw new Error('invalid_scan_job');
      return runScan(d.deps, parsed.data.scanId);
    },
    { connection: d.connection, prefix: d.prefix, concurrency: d.concurrency, autorun: true },
  );
  worker.on('error', (err) => d.log.error('scan.worker_error', errorFields(err)));
  return { close: () => worker.close() };
}

/** Times out, re-enqueues and purges scans every five minutes; replicas take turns via its lock. */
export function startScanMaintenanceLoop(d: {
  connection: Redis;
  prefix: string;
  pool: ReturnType<typeof createPool>;
  store: PgScanStore;
  settings: ScanSettings;
  log: Logger;
}): { stop(): Promise<void> } {
  const queue = new Queue(SCAN_QUEUE, { connection: d.connection, prefix: d.prefix });
  const timer = every(
    'scan_maintenance',
    MAINTENANCE_INTERVAL_MS,
    () =>
      runScanMaintenance({
        pool: d.pool,
        store: d.store,
        queue,
        settings: d.settings,
        now: () => new Date(),
        log: d.log,
      }),
    d.log,
    'scan.maintenance_failed',
  );
  return {
    async stop() {
      clearInterval(timer);
      await queue.close();
    },
  };
}
