import { expect, it } from 'vitest';
import { loadTelemetryConfig } from './config.js';

it('defaults to no exporting and a loopback metrics listener', () => {
  expect(loadTelemetryConfig({}, 'worker')).toEqual({
    traces: { exporter: 'none', serviceName: 'feedbouncer-worker' },
    metrics: { host: '127.0.0.1', port: 9465, maxConnections: 1000 },
    shutdownTimeoutMs: 5000,
  });
  expect(loadTelemetryConfig({}, 'api').metrics.port).toBe(9464);
});
it('enables OTLP only when asked', () => {
  expect(loadTelemetryConfig({ OTEL_TRACES_EXPORTER: 'otlp' }, 'api').traces.exporter).toBe('otlp');
  expect(
    loadTelemetryConfig({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_SDK_DISABLED: 'true' }, 'api').traces
      .exporter,
  ).toBe('none');
});
it('rejects unknown exporters', () => {
  expect(() => loadTelemetryConfig({ OTEL_TRACES_EXPORTER: 'jaeger' }, 'api')).toThrow(
    /OTEL_TRACES_EXPORTER/,
  );
});
it('rejects credentials embedded in the OTLP endpoint', () => {
  let msg = '';
  try {
    loadTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://u:s3cr3t@collector:4318' }, 'api');
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  expect(msg).not.toContain('s3cr3t');
});
it('does not leak credentials from a malformed or wrong-scheme endpoint', () => {
  for (const value of ['https://u:s3cr3t@[bad', 'ftp://u:s3cr3t@collector']) {
    let msg = '';
    try {
      loadTelemetryConfig({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: value }, 'api');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
    expect(msg).not.toContain('s3cr3t');
  }
});
it('allows disabling the metrics listener', () => {
  expect(loadTelemetryConfig({ METRICS_PORT: '0' }, 'api').metrics.port).toBe(0);
});
