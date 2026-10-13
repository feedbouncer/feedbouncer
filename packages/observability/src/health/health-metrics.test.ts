import { describe, expect, it } from 'vitest';
import { createLogger } from '@feedbouncer/service-runtime';
import { createMetrics } from '../metrics.js';
import type { ConnectionHealth } from './derive.js';
import { registerConnectorHealthMetrics, registerQueueMetrics } from './metrics.js';

const log = createLogger('t', 'error', () => {});
const h = (over: Partial<ConnectionHealth>): ConnectionHealth => ({
  connectionId: '11111111-1111-4111-8111-111111111111',
  organizationId: 'o',
  brandId: 'b',
  platform: 'youtube',
  status: 'healthy',
  reason: 'ok',
  lastSuccessAt: new Date(1_000_000),
  lastErrorCode: null,
  lastErrorAt: null,
  consecutiveFailures: 0,
  stalenessMs: 30_000,
  ingestLagMs: 0,
  ...over,
});

describe('connector health gauges', () => {
  it('exports one state series per status, staleness and lag per connection, never tenant ids', async () => {
    const m = createMetrics('worker');
    registerConnectorHealthMetrics(
      m,
      {
        forBrand: async () => [],
        all: async () => ({
          rows: [
            h({}),
            h({
              connectionId: '22222222-2222-4222-8222-222222222222',
              status: 'pending_first_sync',
              reason: 'pending_first_sync',
              lastSuccessAt: null,
              stalenessMs: null,
              lastErrorCode: 'upstream_5xx',
            }),
          ],
          truncated: false,
        }),
      },
      { maxSeries: 1000, cacheMs: 0, log },
    );
    const t = await m.registry.metrics();
    expect(t).toMatch(
      /feedbouncer_connector_health_status\{[^}]*connection_id="11111111[^"]*"[^}]*status="healthy"[^}]*\} 1/,
    );
    expect(t).toMatch(
      /feedbouncer_connector_health_status\{[^}]*connection_id="11111111[^"]*"[^}]*status="degraded"[^}]*\} 0/,
    );
    expect(t).toMatch(
      /feedbouncer_connector_sync_staleness_seconds\{[^}]*connection_id="11111111[^"]*"[^}]*\} 30/,
    );
    expect(t).not.toMatch(
      /feedbouncer_connector_sync_staleness_seconds\{[^}]*connection_id="22222222/,
    );
    expect(t).toMatch(
      /feedbouncer_connector_last_error_info\{[^}]*error_code="upstream_5xx"[^}]*\} 1/,
    );
    expect(t).not.toMatch(/organization|tenant|brand_id/);
  });

  it('drops gauges and counts the error when the reader fails', async () => {
    const m = createMetrics('worker');
    registerConnectorHealthMetrics(
      m,
      {
        forBrand: async () => [],
        all: async () => {
          throw new Error('db down');
        },
      },
      { maxSeries: 10, cacheMs: 0, log },
    );
    registerQueueMetrics(
      m,
      async () => {
        throw new Error('db down');
      },
      { cacheMs: 0, log },
    );
    const t = await m.registry.metrics();
    expect(t).not.toMatch(/feedbouncer_connector_health_status\{/);
    expect(t).not.toMatch(/feedbouncer_queue_depth\{/);
    expect(t).toMatch(
      /feedbouncer_telemetry_collect_errors_total\{[^}]*collector="connector_health"[^}]*\} 1/,
    );
    expect(t).toMatch(
      /feedbouncer_telemetry_collect_errors_total\{[^}]*collector="queues"[^}]*\} 1/,
    );
    expect(t).toContain('process_cpu');
  });

  it('counts a failing collector once per scrape and recovers when the reader does', async () => {
    const m = createMetrics('worker');
    let fail = true;
    registerConnectorHealthMetrics(
      m,
      {
        forBrand: async () => [],
        all: async () => {
          if (fail) throw new Error('db down');
          return { rows: [h({})], truncated: false };
        },
      },
      { maxSeries: 10, cacheMs: 0, log },
    );
    await m.registry.metrics();
    const second = await m.registry.metrics();
    expect(second).toMatch(/feedbouncer_telemetry_collect_errors_total\{[^}]*\} 2/);
    fail = false;
    const third = await m.registry.metrics();
    expect(third).toMatch(/feedbouncer_connector_health_status\{/);
    expect(third).toMatch(/feedbouncer_telemetry_collect_errors_total\{[^}]*\} 2/);
  });

  it('a hung reader is bounded by the collect timeout', async () => {
    const m = createMetrics('worker');
    registerConnectorHealthMetrics(
      m,
      { forBrand: async () => [], all: () => new Promise(() => {}) },
      { maxSeries: 10, cacheMs: 0, timeoutMs: 50, log },
    );
    const t = await m.registry.metrics();
    expect(t).not.toMatch(/feedbouncer_connector_health_status\{/);
    expect(t).toMatch(
      /feedbouncer_telemetry_collect_errors_total\{[^}]*collector="connector_health"[^}]*\} 1/,
    );
  });

  it('reports truncation when there are more connections than maxSeries', async () => {
    const m = createMetrics('worker');
    registerConnectorHealthMetrics(
      m,
      { forBrand: async () => [], all: async () => ({ rows: [h({})], truncated: true }) },
      { maxSeries: 1, cacheMs: 0, log },
    );
    expect(await m.registry.metrics()).toMatch(/feedbouncer_connector_series_truncated\{[^}]*\} 1/);
  });

  it('queue gauges come from the ledger stats', async () => {
    const m = createMetrics('worker');
    registerQueueMetrics(m, async () => [{ platform: 'youtube', depth: 4, oldestAgeMs: 2500 }], {
      cacheMs: 0,
      log,
    });
    const t = await m.registry.metrics();
    expect(t).toMatch(/feedbouncer_queue_depth\{[^}]*queue="platform-youtube"[^}]*\} 4/);
    expect(t).toMatch(
      /feedbouncer_queue_oldest_age_seconds\{[^}]*queue="platform-youtube"[^}]*\} 2.5/,
    );
  });
});
