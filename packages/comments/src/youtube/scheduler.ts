// Time-driven enqueueing of the YouTube cycle job: one job per due connection per
// minute slot. The slot is the idempotency key, so replicas that tick together
// and repeated ticks within a slot deduplicate in the job ledger.
import type { JobProducer } from '@feedbouncer/jobs';
import { YOUTUBE_CYCLE_JOB } from '../jobs/specs.js';
import type { PgYouTubeState } from './state.js';

const SLOT_MS = 60_000;

export interface YouTubeSchedulerDeps {
  state: Pick<PgYouTubeState, 'dueConnections'>;
  producer: Pick<JobProducer, 'enqueue'>;
  clock: () => Date;
  tickSec: number;
  maxConnectionsPerTick: number;
  log: { warn(msg: string, fields?: Record<string, unknown>): void };
}

export class YouTubeCycleScheduler {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<unknown> | null = null;

  constructor(private readonly d: YouTubeSchedulerDeps) {}

  /** One tick. Never throws: a failed query or enqueue is logged, and the next tick retries. */
  async tick(): Promise<{ enqueued: number }> {
    const now = this.d.clock();
    const slot = Math.floor(now.getTime() / SLOT_MS);
    let enqueued = 0;
    try {
      const due = await this.d.state.dueConnections(now, this.d.maxConnectionsPerTick);
      for (const scope of due) {
        try {
          const r = await this.d.producer.enqueue({
            scope,
            platform: 'youtube',
            type: YOUTUBE_CYCLE_JOB.type,
            payload: { connectionId: scope.connectionId },
            idempotencyKey: `${YOUTUBE_CYCLE_JOB.type}:${scope.connectionId}:${slot}`,
          });
          if (r.status === 'enqueued') enqueued++;
        } catch (err) {
          this.#warn('youtube_scheduler.enqueue_failed', err);
        }
      }
    } catch (err) {
      this.#warn('youtube_scheduler.query_failed', err);
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
    }, this.d.tickSec * 1000);
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
