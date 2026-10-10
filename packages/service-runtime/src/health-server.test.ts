import { afterEach, describe, expect, it } from 'vitest';
import { startHealthServer } from './health-server.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(up: boolean) {
  const server = await startHealthServer({
    host: '127.0.0.1',
    port: 0,
    timeoutMs: 100,
    checks: { db: async () => (up ? 1 : Promise.reject(new Error('down: hunter2'))) },
  });
  close = server.close;
  return `http://127.0.0.1:${server.port}`;
}

describe('startHealthServer', () => {
  it('/livez is always 200', async () => {
    const base = await start(false);
    const res = await fetch(`${base}/livez`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('/healthz is 200 with the report when dependencies are up', async () => {
    const base = await start(true);
    const res = await fetch(`${base}/healthz?probe=compose`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok', checks: { db: 'up' } });
  });

  it('/healthz is 503 with no error details when a dependency is down', async () => {
    const base = await start(false);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: 'unavailable', checks: { db: 'down' } });
    expect(text).not.toContain('hunter2');
  });

  it('rejects other methods with 405 and an Allow header', async () => {
    const base = await start(true);
    const res = await fetch(`${base}/healthz`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('returns 404 for unknown paths', async () => {
    const base = await start(true);
    expect((await fetch(`${base}/../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
  });

  it('does not leave an unhandled rejection when the response cannot be sent', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const base = await start(true);
      const ctrl = new AbortController();
      const pending = fetch(`${base}/healthz`, { signal: ctrl.signal }).catch(() => undefined);
      ctrl.abort();
      await pending;
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
