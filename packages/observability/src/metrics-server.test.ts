import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { createLogger } from '@feedbouncer/service-runtime';
import { createMetrics } from './metrics.js';
import { startMetricsServer } from './metrics-server.js';

const log = createLogger('t', 'error', () => {});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

it('serves /metrics only', async () => {
  const m = createMetrics('api');
  const s = (await startMetricsServer({
    host: '127.0.0.1',
    port: await freePort(),
    registry: m.registry,
    log,
  }))!;
  const base = `http://127.0.0.1:${s.port}`;
  const ok = await fetch(`${base}/metrics`);
  expect(ok.status).toBe(200);
  expect(ok.headers.get('content-type')).toBe(m.registry.contentType);
  expect((await fetch(`${base}/`)).status).toBe(404);
  expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
  await s.close();
});

it('port 0 means disabled', async () => {
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
    port: await freePort(),
    registry: broken as never,
    log,
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
    port: await freePort(),
    registry: m.registry,
    log,
  }))!;
  await expect(
    startMetricsServer({ host: '127.0.0.1', port: a.port, registry: m.registry, log }),
  ).resolves.toBeNull();
  await a.close();
});

it('coalesces concurrent scrapes into one in-flight collection', async () => {
  const m = createMetrics('api');
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = {
    contentType: m.registry.contentType,
    metrics: async () => {
      calls += 1;
      await gate;
      return 'x 1\n';
    },
  };
  const s = (await startMetricsServer({
    host: '127.0.0.1',
    port: await freePort(),
    registry: slow as never,
    log,
  }))!;
  const url = `http://127.0.0.1:${s.port}/metrics`;
  const pending = Array.from({ length: 5 }, () => fetch(url));
  await new Promise((r) => setTimeout(r, 100));
  expect(calls).toBe(1);
  release();
  const rs = await Promise.all(pending);
  expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  await fetch(url);
  expect(calls).toBe(2);
  await s.close();
});

it('keeps serving after a 500', async () => {
  const m = createMetrics('api');
  let fail = true;
  const flaky = {
    contentType: m.registry.contentType,
    metrics: async () => {
      if (fail) {
        fail = false;
        throw new Error('boom');
      }
      return 'ok 1\n';
    },
  };
  const s = (await startMetricsServer({
    host: '127.0.0.1',
    port: await freePort(),
    registry: flaky as never,
    log,
  }))!;
  const url = `http://127.0.0.1:${s.port}/metrics`;
  expect((await fetch(url)).status).toBe(500);
  const r = await fetch(url);
  expect(r.status).toBe(200);
  expect(await r.text()).toBe('ok 1\n');
  await s.close();
});

it('HEAD returns 200 with an empty body and query strings are served', async () => {
  const m = createMetrics('api');
  const s = (await startMetricsServer({
    host: '127.0.0.1',
    port: await freePort(),
    registry: m.registry,
    log,
  }))!;
  const base = `http://127.0.0.1:${s.port}`;
  const head = await fetch(`${base}/metrics`, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  expect((await fetch(`${base}/metrics?x=1`)).status).toBe(200);
  await s.close();
});
