import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Platform } from '@feedbouncer/connectors';
import { bullJobId } from './keys.js';

export const LANE = /^[a-z][a-z0-9]{0,15}$/;
export type LaneOf = (jobType: string) => string | null;
export const NO_LANES: LaneOf = () => null;

/** Platform queues carry connector work; lane queues isolate slow work (e.g. LLM calls) per platform. */
export const queueName = (p: Platform, lane: string | null = null): string =>
  lane === null ? `platform-${p}` : `lane-${lane}-${p}`;

export function laneMap(defs: Iterable<{ readonly type: string; readonly lane?: string }>): LaneOf {
  const m = new Map<string, string>();
  for (const d of defs) {
    if (d.lane === undefined) continue;
    if (!LANE.test(d.lane)) throw new RangeError('invalid lane');
    m.set(d.type, d.lane);
  }
  return (t) => m.get(t) ?? null;
}

/**
 * Lanes of job types whose definitions live outside this package, for tools
 * that route jobs without the worker's registry (the DLQ replay CLI). Kept in
 * step with the job specs by a test in the owning package.
 */
export const KNOWN_JOB_LANES: Readonly<Record<string, string>> = {
  comment_classify: 'classify',
  classifier_rerun: 'classify',
};
export const knownLaneOf: LaneOf = (t) => KNOWN_JOB_LANES[t] ?? null;

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

/** Upper bound on one enqueue; covers a Redis that is down before the first connect. */
export const ADD_TIMEOUT_MS = 5_000;

export class QueueSet {
  readonly #queues = new Map<string, Queue>();
  readonly #connection: Redis;
  readonly #prefix: string;
  readonly #addTimeoutMs: number;
  private readonly laneOf: LaneOf;

  constructor(o: { connection: Redis; prefix: string; addTimeoutMs?: number; laneOf?: LaneOf }) {
    if (!QUEUE_PREFIX.test(o.prefix)) throw new RangeError('invalid queue prefix');
    this.#connection = o.connection;
    this.#prefix = o.prefix;
    this.#addTimeoutMs = o.addTimeoutMs ?? ADD_TIMEOUT_MS;
    this.laneOf = o.laneOf ?? NO_LANES;
  }

  nameFor(p: Platform, jobType: string): string {
    return queueName(p, this.laneOf(jobType));
  }

  queue(p: Platform, lane: string | null = null): Queue {
    const name = queueName(p, lane);
    let q = this.#queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.#connection, prefix: this.#prefix });
      // Connection errors are reported by the shared ioredis client's own handler.
      q.on('error', () => {});
      this.#queues.set(name, q);
    }
    return q;
  }

  async add(p: Platform, jobType: string, ledgerId: string, key: string): Promise<void> {
    const data: QueueJobData = { v: 1, ledgerId };
    const added = this.queue(p, this.laneOf(jobType)).add(jobType, data, {
      ...JOB_ADD_OPTIONS,
      jobId: bullJobId(key),
    });
    // BullMQ waits for the connection before the first command, so an outage
    // at startup would otherwise block the caller indefinitely. A late add is
    // harmless: the job id is deterministic and the sweeper repairs gaps.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('job queue unavailable: enqueue timed out')),
        this.#addTimeoutMs,
      );
    });
    added.catch(() => {});
    try {
      await Promise.race([added, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    const all = [...this.#queues.values()];
    this.#queues.clear();
    await Promise.all(all.map((q) => q.close()));
  }
}
