// Time-driven enqueueing for ad moderation. Each tick enqueues one ad_discovery
// per active meta_ads connection and one ad_poll per Page / IG connection with
// due ad sources. The job's `bucket` is the current time slot, so replicas that
// tick in the same slot, and repeated ticks within it, deduplicate in the ledger.
import type pg from 'pg';
import type { Clock } from '@feedbouncer/connectors';
import type { JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { PgAdTracking } from './ads/tracking.js';

export interface SchedulerSettings {
  tickSec: number;
  discoveryIntervalSec: number;
  pollIntervalSec: number;
  graceDays: number;
  maxConnectionsPerTick: number;
}

export interface TickResult {
  discovery: number;
  poll: number;
  deduplicated: number;
  failed: number;
}

interface SchedulerLog {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

interface SchedulerDeps {
  pool: pg.Pool;
  producer: Pick<JobProducer, 'enqueue'>;
  tracking: PgAdTracking;
  clock: Clock;
  log: SchedulerLog;
  settings: SchedulerSettings;
}

export class PollScheduler {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<unknown> | null = null;
  /** Last ads connection enqueued: the next tick continues after it, wrapping at the end. */
  #adsCursor: string | null = null;

  constructor(private readonly d: SchedulerDeps) {}

  /** One tick. Never throws: a failed enqueue is logged and counted. */
  async tick(): Promise<TickResult> {
    const { pool, tracking, clock, settings } = this.d;
    const result: TickResult = { discovery: 0, poll: 0, deduplicated: 0, failed: 0 };
    const nowMs = clock.now();
    const slot = (intervalSec: number) => Math.floor(nowMs / 1000 / intervalSec);
    const enqueue = async (
      scope: ConnectionScope,
      platform: 'meta_ads' | 'facebook' | 'instagram',
      type: 'ad_discovery' | 'ad_poll',
      bucket: number,
    ) => {
      try {
        const r = await this.d.producer.enqueue({ scope, platform, type, payload: { bucket } });
        if (r.status === 'deduplicated') result.deduplicated++;
        else result[type === 'ad_discovery' ? 'discovery' : 'poll']++;
      } catch {
        result.failed++;
        this.d.log.warn('scheduler.enqueue_failed', { jobType: type, platform });
      }
    };
    try {
      const adsConnections = await pool.query<{
        organization_id: string;
        brand_id: string;
        id: string;
      }>(
        `SELECT organization_id, brand_id, id FROM connection
          WHERE platform = 'meta_ads' AND status = 'active' AND ($2::uuid IS NULL OR id > $2)
          ORDER BY id LIMIT $1`,
        [settings.maxConnectionsPerTick, this.#adsCursor],
      );
      // A short page is the end of the list: the next tick starts over.
      this.#adsCursor =
        adsConnections.rows.length < settings.maxConnectionsPerTick
          ? null
          : adsConnections.rows[adsConnections.rows.length - 1]!.id;
      for (const c of adsConnections.rows) {
        const scope = {
          organizationId: c.organization_id,
          brandId: c.brand_id,
          connectionId: c.id,
        };
        await enqueue(scope, 'meta_ads', 'ad_discovery', slot(settings.discoveryIntervalSec));
      }
      const due = await tracking.connectionsWithDueSources(new Date(nowMs), {
        graceDays: settings.graceDays,
        limit: settings.maxConnectionsPerTick,
      });
      for (const c of due)
        await enqueue(c.scope, c.platform, 'ad_poll', slot(settings.pollIntervalSec));
    } catch {
      result.failed++;
      this.d.log.warn('scheduler.query_failed');
    }
    return result;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#running) return;
      this.#running = this.tick().finally(() => {
        this.#running = null;
      });
    }, this.d.settings.tickSec * 1000);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }
}
