import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createLogger, currentTraceIds, withSpan } from '@feedbouncer/service-runtime';
import { loadTelemetryConfig } from './config.js';
import { initTracing } from './tracing-sdk.js';
import { resetTracingForTests } from './testing/index.js';

const log = createLogger('test', 'error', () => {});
// Dynamic key: the endpoint is read by the exporter itself, not by our code.
const TRACES_ENDPOINT = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT';
const saved = { ...process.env };
afterEach(() => {
  resetTracingForTests();
  process.env = { ...saved };
});

async function countingServer(): Promise<{ server: Server; url: string; hits: () => number }> {
  let n = 0;
  const server = createServer((req, res) => {
    n++;
    req.resume();
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://127.0.0.1:${port}/v1/traces`, hits: () => n };
}

it('makes no network calls when exporting is off, but still assigns trace ids', async () => {
  const c = await countingServer();
  process.env[TRACES_ENDPOINT] = c.url;
  const h = initTracing(loadTelemetryConfig({}, 'worker'), log);
  expect(h.exporting).toBe(false);
  const ids = await withSpan('s', {}, async () => currentTraceIds());
  expect(ids?.trace_id).toMatch(/^[0-9a-f]{32}$/);
  await h.shutdown();
  expect(c.hits()).toBe(0);
  c.server.close();
});

it('exports when OTEL_TRACES_EXPORTER=otlp', async () => {
  const c = await countingServer();
  process.env[TRACES_ENDPOINT] = c.url;
  const h = initTracing(loadTelemetryConfig({ OTEL_TRACES_EXPORTER: 'otlp' }, 'worker'), log);
  await withSpan('s', {}, async () => undefined);
  await h.forceFlush();
  expect(c.hits()).toBeGreaterThan(0);
  await h.shutdown();
  c.server.close();
});

it('an unreachable collector never fails work and shutdown is bounded', async () => {
  process.env[TRACES_ENDPOINT] = 'http://127.0.0.1:9/v1/traces';
  const cfg = {
    ...loadTelemetryConfig({ OTEL_TRACES_EXPORTER: 'otlp' }, 'worker'),
    shutdownTimeoutMs: 300,
  };
  const h = initTracing(cfg, log);
  for (let i = 0; i < 50; i++) await expect(withSpan('s', {}, async () => i)).resolves.toBe(i);
  const t0 = Date.now();
  await h.shutdown();
  expect(Date.now() - t0).toBeLessThan(1_500);
});

it('accepts extra span processors (used by tests)', async () => {
  const exp = new InMemorySpanExporter();
  initTracing(loadTelemetryConfig({}, 'api'), log, {
    spanProcessors: [new SimpleSpanProcessor(exp)],
  });
  await withSpan('s', {}, async () => undefined);
  expect(exp.getFinishedSpans().map((s) => s.name)).toEqual(['s']);
});
