import { Gauge } from '@prometheus-io/client';
import { queueName, type QueueStat } from '@feedbouncer/jobs';
import { errorFields, withTimeout, type Logger } from '@feedbouncer/service-runtime';
import type { FbMetrics } from '../metrics.js';
import { HEALTH_STATUSES, type ConnectionHealth } from './derive.js';
import type { HealthReader } from './pg-reader.js';

const DEFAULT_CACHE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * One shared snapshot per collector: loaded at most once per ttlMs, with concurrent scrapes
 * and gauges awaiting the same load. A failed or timed-out load is counted and logged once,
 * leaves the snapshot empty (so the gauges are omitted) and is retried on the next scrape.
 * The counter's scrape hook awaits the same load, so a failure shows up in that scrape.
 */
function snapshotLoader<T>(
  m: FbMetrics,
  log: Logger,
  collector: 'connector_health' | 'queues',
  load: () => Promise<T>,
  o: { cacheMs?: number; timeoutMs?: number },
): () => Promise<T | null> {
  const ttlMs = o.cacheMs ?? DEFAULT_CACHE_MS;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let value: T | null = null;
  let loadedAt = -Infinity;
  let inflight: Promise<void> | undefined;

  const read = async (): Promise<T | null> => {
    if (!inflight && Date.now() - loadedAt >= ttlMs) {
      inflight = withTimeout(Promise.resolve().then(load), timeoutMs, 'collect')
        .then((v) => {
          value = v;
          loadedAt = Date.now();
        })
        .catch((err: unknown) => {
          value = null;
          loadedAt = -Infinity;
          m.collectErrors.inc({ collector });
          log.warn('telemetry.collect_failed', { collector, ...errorFields(err) });
        })
        .finally(() => {
          inflight = undefined;
        });
    }
    await inflight;
    return value;
  };
  m.scrapeHooks.push(async () => void (await read()));
  return read;
}

/** A gauge that is cleared and refilled from the snapshot on every scrape; absent when it failed. */
function snapshotGauge<T, L extends string = never>(
  m: FbMetrics,
  load: () => Promise<T | null>,
  def: { name: string; help: string; labelNames?: readonly L[] },
  fill: (gauge: Gauge<L>, snapshot: T) => void,
): void {
  new Gauge<L>({
    ...def,
    labelNames: def.labelNames ?? [],
    registers: [m.registry],
    async collect() {
      this.reset();
      const s = await load();
      if (s) fill(this, s);
    },
  });
}

export function registerConnectorHealthMetrics(
  m: FbMetrics,
  reader: HealthReader,
  o: { maxSeries: number; cacheMs?: number; timeoutMs?: number; log: Logger },
): void {
  const load = snapshotLoader(m, o.log, 'connector_health', () => reader.all(o.maxSeries), o);
  const labels = ['connection_id', 'platform'] as const;
  const ids = (h: ConnectionHealth) => ({ connection_id: h.connectionId, platform: h.platform });
  snapshotGauge(
    m,
    load,
    {
      name: 'feedbouncer_connector_health_status',
      help: 'Current health state per connection (1 for the current state, 0 otherwise).',
      labelNames: [...labels, 'status'] as const,
    },
    (g, s) => {
      for (const h of s.rows)
        for (const status of HEALTH_STATUSES)
          g.set({ ...ids(h), status }, h.status === status ? 1 : 0);
    },
  );
  snapshotGauge(
    m,
    load,
    {
      name: 'feedbouncer_connector_last_success_timestamp_seconds',
      help: 'Unix time of the last successful sync (read or accepted webhook). Absent before the first sync.',
      labelNames: labels,
    },
    (g, s) => {
      for (const h of s.rows) if (h.lastSuccessAt) g.set(ids(h), h.lastSuccessAt.getTime() / 1000);
    },
  );
  snapshotGauge(
    m,
    load,
    {
      name: 'feedbouncer_connector_sync_staleness_seconds',
      help: 'Seconds since the last successful sync. Absent while pending first sync.',
      labelNames: labels,
    },
    (g, s) => {
      for (const h of s.rows) if (h.stalenessMs !== null) g.set(ids(h), h.stalenessMs / 1000);
    },
  );
  snapshotGauge(
    m,
    load,
    {
      name: 'feedbouncer_connector_ingest_lag_seconds',
      help: 'Age of the oldest queued (received, unprocessed) job for the connection; 0 when none.',
      labelNames: labels,
    },
    (g, s) => {
      for (const h of s.rows) g.set(ids(h), h.ingestLagMs / 1000);
    },
  );
  snapshotGauge(
    m,
    load,
    {
      name: 'feedbouncer_connector_consecutive_failures',
      help: 'Platform call failures since the last success.',
      labelNames: labels,
    },
    (g, s) => {
      for (const h of s.rows) g.set(ids(h), h.consecutiveFailures);
    },
  );
  snapshotGauge(
    m,
    load,
    {
      name: 'feedbouncer_connector_last_error_info',
      help: 'Last error code seen for the connection (value is always 1).',
      labelNames: [...labels, 'error_code'] as const,
    },
    (g, s) => {
      for (const h of s.rows)
        if (h.lastErrorCode) g.set({ ...ids(h), error_code: h.lastErrorCode }, 1);
    },
  );
  snapshotGauge(
    m,
    load,
    {
      name: 'feedbouncer_connector_series_truncated',
      help: '1 when more connections exist than METRICS_MAX_CONNECTIONS.',
    },
    (g, s) => g.set(s.truncated ? 1 : 0),
  );
}

export function registerQueueMetrics(
  m: FbMetrics,
  stats: () => Promise<readonly QueueStat[]>,
  o: { cacheMs?: number; timeoutMs?: number; log: Logger },
): void {
  const load = snapshotLoader(m, o.log, 'queues', stats, o);
  snapshotGauge(
    m,
    load,
    {
      name: 'feedbouncer_queue_depth',
      help: 'Queued (not yet completed) jobs per queue, from the ledger.',
      labelNames: ['queue'] as const,
    },
    (g, qs) => {
      for (const q of qs) g.set({ queue: queueName(q.platform) }, q.depth);
    },
  );
  snapshotGauge(
    m,
    load,
    {
      name: 'feedbouncer_queue_oldest_age_seconds',
      help: 'Age of the oldest queued job per queue.',
      labelNames: ['queue'] as const,
    },
    (g, qs) => {
      for (const q of qs) g.set({ queue: queueName(q.platform) }, q.oldestAgeMs / 1000);
    },
  );
}
