import { Gauge } from '@prometheus-io/client';
import { queueName, type QueueStat } from '@feedbouncer/jobs';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import type { FbMetrics } from '../metrics.js';
import { HEALTH_STATUSES } from './derive.js';
import type { HealthReader } from './pg-reader.js';

const DEFAULT_CACHE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`collect exceeded ${ms}ms`)), ms);
    timer.unref();
  });
  p.catch(() => {}); // a late rejection after the timeout must not be unhandled
  return Promise.race([p, bound]).finally(() => clearTimeout(timer));
}

/**
 * Shares one in-flight load between all gauges of a scrape and keeps a settled value for
 * ttlMs. A failure (including timeout) is retried on the next scrape.
 */
function cached<T>(load: () => Promise<T>, ttlMs: number, timeoutMs: number): () => Promise<T> {
  let at = -Infinity;
  let value: Promise<T> | undefined;
  let pending = false;
  return () => {
    const now = Date.now();
    if (!value || (!pending && now - at >= ttlMs)) {
      let started: Promise<T>;
      try {
        started = withTimeout(load(), timeoutMs);
      } catch (err) {
        started = Promise.reject(err);
      }
      value = started;
      pending = true;
      at = now;
      const settle = (ok: boolean) => {
        if (value !== started) return;
        pending = false;
        at = ok ? Date.now() : -Infinity;
      };
      started.then(
        () => settle(true),
        () => settle(false),
      );
    }
    return value;
  };
}

/** Counts each failed load once (however many gauges await it) and logs it at warn. */
function failureReporter(m: FbMetrics, log: Logger, collector: 'connector_health' | 'queues') {
  const seen = new WeakSet<object>();
  return (load: Promise<unknown>, err: unknown): void => {
    if (seen.has(load)) return;
    seen.add(load);
    m.collectErrors.inc({ collector });
    log.warn('telemetry.collect_failed', { collector, ...errorFields(err) });
  };
}

export function registerConnectorHealthMetrics(
  m: FbMetrics,
  reader: HealthReader,
  o: { maxSeries: number; cacheMs?: number; timeoutMs?: number; log: Logger },
): void {
  const snapshot = cached(
    () => reader.all(o.maxSeries),
    o.cacheMs ?? DEFAULT_CACHE_MS,
    o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const r = [m.registry];
  const labels = ['connection_id', 'platform'] as const;
  type Loaded = Awaited<ReturnType<typeof snapshot>>;
  const report = failureReporter(m, o.log, 'connector_health');
  const load = async (g: { reset(): void }): Promise<Loaded | null> => {
    g.reset();
    const p = snapshot();
    try {
      return await p;
    } catch (err) {
      report(p, err);
      return null;
    }
  };
  m.scrapeHooks.push(async () => {
    await load({ reset() {} });
  });
  new Gauge({
    name: 'feedbouncer_connector_health_status',
    help: 'Current health state per connection (1 for the current state, 0 otherwise).',
    labelNames: [...labels, 'status'] as const,
    registers: r,
    async collect() {
      const s = await load(this);
      for (const h of s?.rows ?? []) {
        for (const st of HEALTH_STATUSES) {
          this.set(
            { connection_id: h.connectionId, platform: h.platform, status: st },
            h.status === st ? 1 : 0,
          );
        }
      }
    },
  });
  new Gauge({
    name: 'feedbouncer_connector_last_success_timestamp_seconds',
    help: 'Unix time of the last successful sync (read or accepted webhook). Absent before the first sync.',
    labelNames: labels,
    registers: r,
    async collect() {
      const s = await load(this);
      for (const h of s?.rows ?? []) {
        if (h.lastSuccessAt) {
          this.set(
            { connection_id: h.connectionId, platform: h.platform },
            h.lastSuccessAt.getTime() / 1000,
          );
        }
      }
    },
  });
  new Gauge({
    name: 'feedbouncer_connector_sync_staleness_seconds',
    help: 'Seconds since the last successful sync. Absent while pending first sync.',
    labelNames: labels,
    registers: r,
    async collect() {
      const s = await load(this);
      for (const h of s?.rows ?? []) {
        if (h.stalenessMs !== null) {
          this.set({ connection_id: h.connectionId, platform: h.platform }, h.stalenessMs / 1000);
        }
      }
    },
  });
  new Gauge({
    name: 'feedbouncer_connector_ingest_lag_seconds',
    help: 'Age of the oldest queued (received, unprocessed) job for the connection; 0 when none.',
    labelNames: labels,
    registers: r,
    async collect() {
      const s = await load(this);
      for (const h of s?.rows ?? []) {
        this.set({ connection_id: h.connectionId, platform: h.platform }, h.ingestLagMs / 1000);
      }
    },
  });
  new Gauge({
    name: 'feedbouncer_connector_consecutive_failures',
    help: 'Platform call failures since the last success.',
    labelNames: labels,
    registers: r,
    async collect() {
      const s = await load(this);
      for (const h of s?.rows ?? []) {
        this.set({ connection_id: h.connectionId, platform: h.platform }, h.consecutiveFailures);
      }
    },
  });
  new Gauge({
    name: 'feedbouncer_connector_last_error_info',
    help: 'Last error code seen for the connection (value is always 1).',
    labelNames: [...labels, 'error_code'] as const,
    registers: r,
    async collect() {
      const s = await load(this);
      for (const h of s?.rows ?? []) {
        if (h.lastErrorCode) {
          this.set(
            { connection_id: h.connectionId, platform: h.platform, error_code: h.lastErrorCode },
            1,
          );
        }
      }
    },
  });
  new Gauge({
    name: 'feedbouncer_connector_series_truncated',
    help: '1 when more connections exist than METRICS_MAX_CONNECTIONS.',
    registers: r,
    async collect() {
      const s = await load(this);
      if (s) this.set(s.truncated ? 1 : 0);
    },
  });
}

export function registerQueueMetrics(
  m: FbMetrics,
  stats: () => Promise<readonly QueueStat[]>,
  o: { cacheMs?: number; timeoutMs?: number; log: Logger },
): void {
  const snapshot = cached(stats, o.cacheMs ?? DEFAULT_CACHE_MS, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const report = failureReporter(m, o.log, 'queues');
  const load = async (g: { reset(): void }) => {
    g.reset();
    const p = snapshot();
    try {
      return await p;
    } catch (err) {
      report(p, err);
      return null;
    }
  };
  m.scrapeHooks.push(async () => {
    await load({ reset() {} });
  });
  new Gauge({
    name: 'feedbouncer_queue_depth',
    help: 'Queued (not yet completed) jobs per queue, from the ledger.',
    labelNames: ['queue'] as const,
    registers: [m.registry],
    async collect() {
      for (const q of (await load(this)) ?? []) this.set({ queue: queueName(q.platform) }, q.depth);
    },
  });
  new Gauge({
    name: 'feedbouncer_queue_oldest_age_seconds',
    help: 'Age of the oldest queued job per queue.',
    labelNames: ['queue'] as const,
    registers: [m.registry],
    async collect() {
      for (const q of (await load(this)) ?? []) {
        this.set({ queue: queueName(q.platform) }, q.oldestAgeMs / 1000);
      }
    },
  });
}
