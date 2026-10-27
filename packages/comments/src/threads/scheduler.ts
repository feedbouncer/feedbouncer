// Time-driven enqueueing of the Threads poll job: one job per due connection per wake-up
// slot. The slot is part of the job's external reference, so replicas that tick together and
// repeated ticks within a slot deduplicate in the job ledger. Webhooks only mark posts due;
// this is what turns that into a poll within a slot or two.
import { THREADS_WAKE_TICK_SEC } from '@feedbouncer/connector-threads';
import type { Clock } from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { Logger } from '@feedbouncer/service-runtime';
import { THREADS_POLL_JOB } from '../jobs/specs.js';
import type { PgThreadsPolling } from './polling.js';

const MAX_CONNECTIONS_PER_TICK = 500;

export interface ThreadsSchedulerDeps {
  polling: Pick<PgThreadsPolling, 'dueConnections'>;
  producer: Pick<JobProducer, 'enqueue'>;
  clock: Clock;
  log: Pick<Logger, 'warn'>;
  tickSec?: number;
}

export class ThreadsPollScheduler {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<unknown> | null = null;
  readonly #tickSec: number;

  constructor(private readonly d: ThreadsSchedulerDeps) {
    this.#tickSec = d.tickSec ?? THREADS_WAKE_TICK_SEC;
  }

  /** One tick. Never throws: a failed query or enqueue is logged, and the next tick retries. */
  async tick(): Promise<{ enqueued: number }> {
    const nowMs = this.d.clock.now();
    const bucket = Math.floor(nowMs / 1000 / this.#tickSec);
    let enqueued = 0;
    try {
      const due = await this.d.polling.dueConnections(new Date(nowMs), MAX_CONNECTIONS_PER_TICK);
      for (const scope of due) {
        try {
          const r = await this.d.producer.enqueue({
            scope,
            platform: 'threads',
            type: THREADS_POLL_JOB.type,
            payload: { bucket },
          });
          if (r.status === 'enqueued') enqueued++;
        } catch (err) {
          this.#warn('threads_scheduler.enqueue_failed', err);
        }
      }
    } catch (err) {
      this.#warn('threads_scheduler.query_failed', err);
    }
    return { enqueued };
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#running) return;
      this.#running = this.tick().finally(() => {
        this.#running = null;
      });
    }, this.#tickSec * 1000);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  #warn(msg: string, err: unknown): void {
    this.d.log.warn(msg, { errorName: err instanceof Error ? err.name : 'unknown' });
  }
}
