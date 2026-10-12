import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Platform } from '@feedbouncer/connectors';
import { bullJobId } from './keys.js';

export const queueName = (p: Platform): string => `platform-${p}`;
export const QUEUE_PREFIX = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Attempts and backoff here only cover worker crashes and stalls; retry policy
 * is applied by the runner from the ledger, which re-adds the job with a delay.
 */
export const JOB_ADD_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const;

/** Redis carries only the ledger id; the payload stays in Postgres. */
export interface QueueJobData {
  readonly v: 1;
  readonly ledgerId: string;
}

export class QueueSet {
  readonly #queues = new Map<Platform, Queue>();
  readonly #connection: Redis;
  readonly #prefix: string;

  constructor(o: { connection: Redis; prefix: string }) {
    if (!QUEUE_PREFIX.test(o.prefix)) throw new RangeError('invalid queue prefix');
    this.#connection = o.connection;
    this.#prefix = o.prefix;
  }

  queue(p: Platform): Queue {
    let q = this.#queues.get(p);
    if (!q) {
      q = new Queue(queueName(p), { connection: this.#connection, prefix: this.#prefix });
      // Connection errors are reported by the shared ioredis client's own handler.
      q.on('error', () => {});
      this.#queues.set(p, q);
    }
    return q;
  }

  async add(
    p: Platform,
    jobType: string,
    ledgerId: string,
    key: string,
    delayMs?: number,
  ): Promise<void> {
    const data: QueueJobData = { v: 1, ledgerId };
    await this.queue(p).add(jobType, data, {
      ...JOB_ADD_OPTIONS,
      jobId: bullJobId(key),
      ...(delayMs ? { delay: delayMs } : {}),
    });
  }

  async close(): Promise<void> {
    const all = [...this.#queues.values()];
    this.#queues.clear();
    await Promise.all(all.map((q) => q.close()));
  }
}
