// Keeps the operator guide honest: every metric the code registers, every health
// state, env var and correlation field must appear in docs/operations/observability.md.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const doc = readFileSync('docs/operations/observability.md', 'utf8');
const srcs = [
  'packages/observability/src/metrics.ts',
  'packages/observability/src/health/metrics.ts',
]
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');
const metricNames = [...srcs.matchAll(/name: '(feedbouncer_[a-z_]+)'/g)].map((m) => m[1]);

test('every emitted metric is documented', () => {
  assert.ok(metricNames.length >= 18);
  for (const n of metricNames) assert.ok(doc.includes(`\`${n}\``), `undocumented metric ${n}`);
});

test('every health state and env var is documented', () => {
  for (const s of [
    'pending_first_sync',
    'healthy',
    'degraded',
    'needs_reconnection',
    'disabled',
  ]) {
    assert.ok(doc.includes(`\`${s}\``), s);
  }
  for (const v of [
    'LOG_LEVEL',
    'OTEL_TRACES_EXPORTER',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_SERVICE_NAME',
    'OTEL_SDK_DISABLED',
    'METRICS_HOST',
    'METRICS_PORT',
    'METRICS_MAX_CONNECTIONS',
    'TELEMETRY_SHUTDOWN_TIMEOUT_MS',
    'CONNECTOR_STALE_AFTER_SECONDS',
    'CONNECTOR_LAG_DEGRADED_SECONDS',
    'CONNECTOR_FAILURES_DEGRADED',
  ]) {
    assert.ok(doc.includes(`\`${v}\``), v);
  }
});

test('every correlation field is documented', () => {
  for (const f of [
    'tenant_id',
    'brand_id',
    'connector_id',
    'connector_type',
    'job_id',
    'request_id',
    'trace_id',
    'span_id',
  ]) {
    assert.ok(doc.includes(`\`${f}\``), f);
  }
});
