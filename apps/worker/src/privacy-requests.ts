import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  PRIVACY_QUEUE,
  PrivacyJobData,
  processPrivacyRequest,
  type PrivacyProcessorDeps,
} from '@feedbouncer/privacy';
import { errorFields } from '@feedbouncer/service-runtime';
import { every } from './interval.js';

const ATTEMPTS = 3;
const SWEEP_INTERVAL_MS = 60_000;
const STALE_QUEUED_MS = 5 * 60_000;

export interface PrivacyRequestWorkerDeps {
  connection: Redis;
  prefix: string;
  concurrency: number;
  deps: PrivacyProcessorDeps;
  log: PrivacyProcessorDeps['log'];
  sweepIntervalMs?: number;
  backoffMs?: number;
}

/**
 * Consumes the privacy queue, which carries request ids only. A sweeper re-enqueues requests
 * still queued after five minutes, so a lost Redis job cannot strand one.
 */
export function startPrivacyRequestWorker(d: PrivacyRequestWorkerDeps): {
  close(): Promise<void>;
  enqueue(requestId: string): Promise<void>;
} {
  const { connection, prefix, log } = d;
  const queue = new Queue(PRIVACY_QUEUE, { connection, prefix });
  const worker = new Worker(
    PRIVACY_QUEUE,
    (job: Job) => {
      const parsed = PrivacyJobData.safeParse(job.data);
      if (!parsed.success) throw new Error('invalid_privacy_job');
      return processPrivacyRequest(d.deps, parsed.data.requestId, {
        finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      });
    },
    { connection, prefix, concurrency: d.concurrency, autorun: true },
  );
  worker.on('error', (err) => log.error('privacy.worker_error', errorFields(err)));

  const enqueue = async (requestId: string) => {
    await queue.add(
      'process',
      { v: 1, requestId },
      {
        jobId: requestId,
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: d.backoffMs ?? 5_000 },
        removeOnComplete: true,
        removeOnFail: 1000,
      },
    );
  };
  const sweeper = every(
    'privacy_requeue',
    d.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
    async () => {
      for (const id of await d.deps.store.staleQueued(STALE_QUEUED_MS)) await enqueue(id);
    },
    log,
    'privacy.requeue_failed',
  );

  return {
    enqueue,
    async close() {
      clearInterval(sweeper);
      await worker.close();
      await queue.close();
    },
  };
}
