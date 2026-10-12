import { expect, it } from 'vitest';
import { createLogger } from '@feedbouncer/service-runtime';
import { createMetrics } from './metrics.js';
import { startMetricsServer } from './metrics-server.js';

const log = createLogger('t', 'error', () => {});

it('serves /metrics only', async () => {
  const m = createMetrics('api');
  const s = (await startMetricsServer({
    host: '127.0.0.1',
    port: 0,
    registry: m.registry,
    log,
    allowEphemeral: true,
  }))!;
  const base = `http://127.0.0.1:${s.port}`;
  const ok = await fetch(`${base}/metrics`);
  expect(ok.status).toBe(200);
  expect(ok.headers.get('content-type')).toBe(m.registry.contentType);
  expect((await fetch(`${base}/`)).status).toBe(404);
  expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
  await s.close();
});

it('port 0 without allowEphemeral means disabled', async () => {
  expect(
    await startMetricsServer({
      host: '127.0.0.1',
      port: 0,
      registry: createMetrics('api').registry,
      log,
    }),
  ).toBeNull();
});

it('a failing collector yields 500 without detail and the server keeps serving', async () => {
  const m = createMetrics('api');
  const broken = {
    ...m.registry,
    metrics: async () => {
      throw new Error('db password=x');
    },
    contentType: m.registry.contentType,
  };
  const s = (await startMetricsServer({
    host: '127.0.0.1',
    port: 0,
    registry: broken as never,
    log,
    allowEphemeral: true,
  }))!;
  const r = await fetch(`http://127.0.0.1:${s.port}/metrics`);
  expect(r.status).toBe(500);
  expect(await r.text()).toBe('metrics unavailable\n');
  await s.close();
});

it('a port conflict is logged and does not throw', async () => {
  const m = createMetrics('api');
  const a = (await startMetricsServer({
    host: '127.0.0.1',
    port: 0,
    registry: m.registry,
    log,
    allowEphemeral: true,
  }))!;
  await expect(
    startMetricsServer({ host: '127.0.0.1', port: a.port, registry: m.registry, log }),
  ).resolves.toBeNull();
  await a.close();
});
