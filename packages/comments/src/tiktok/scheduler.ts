// Time-driven enqueueing of the TikTok poll jobs: one job per due connection per
// interval slot. The slot is the idempotency key, so replicas that tick together
// and repeated ticks within a slot deduplicate in the job ledger.
import type { JobProducer } from '@feedbouncer/jobs';
import { TIKTOK_ADS_POLL_JOB, TIKTOK_POLL_JOB } from '../jobs/specs.js';
import type { PgTikTokPolling, TikTokPollPlatform } from './polling.js';

const JOB_OF = {
  tiktok: TIKTOK_POLL_JOB.type,
  tiktok_ads: TIKTOK_ADS_POLL_JOB.type,
} as const satisfies Record<TikTokPollPlatform, string>;

export interface TikTokSchedulerDeps {
  polling: PgTikTokPolling;
  producer: Pick<JobProducer, 'enqueue'>;
  clock: () => Date;
  platforms: readonly TikTokPollPlatform[];
  tickSec: number;
  maxConnectionsPerTick: number;
  intervals: { tiktok: number; tiktok_ads: number };
  log: { warn(msg: string, fields?: Record<string, unknown>): void };
}

export class TikTokPollScheduler {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<unknown> | null = null;

  constructor(private readonly d: TikTokSchedulerDeps) {}

  /** One tick. Never throws: a failed query or enqueue is logged, and the next tick retries. */
  async tick(): Promise<{ enqueued: number }> {
    const now = this.d.clock();
    let enqueued = 0;
    for (const platform of this.d.platforms) {
      const type = JOB_OF[platform];
      const idempotencyKey = `${type}:${Math.floor(now.getTime() / 1000 / this.d.intervals[platform])}`;
      try {
        const due = await this.d.polling.dueConnections(
          platform,
          now,
          this.d.maxConnectionsPerTick,
        );
        for (const scope of due) {
          try {
            const r = await this.d.producer.enqueue({
              scope,
              platform,
              type,
              payload: { connectionId: scope.connectionId },
              idempotencyKey,
            });
            if (r.status === 'enqueued') enqueued++;
          } catch (err) {
            this.#warn('tiktok_scheduler.enqueue_failed', platform, err);
          }
        }
      } catch (err) {
        this.#warn('tiktok_scheduler.query_failed', platform, err);
      }
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

  #warn(msg: string, platform: TikTokPollPlatform, err: unknown): void {
    this.d.log.warn(msg, { platform, errorName: err instanceof Error ? err.name : 'unknown' });
  }
}
