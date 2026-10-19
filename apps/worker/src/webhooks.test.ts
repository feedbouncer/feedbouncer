import { createMetrics } from '@feedbouncer/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@feedbouncer/service-runtime';
import { startWebhookLoops } from './webhooks.js';

const log = createLogger('test', 'debug', () => {});

afterEach(() => {
  vi.useRealTimers();
});

describe('startWebhookLoops', () => {
  it('polls for due deliveries, reaps expired leases and purges, until stopped', async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const connect = vi.fn(async () => ({
      query,
      release: () => {},
    }));
    const registry = createMetrics('worker').registry;
    const before = vi.getTimerCount();
    const loops = startWebhookLoops(
      { concurrency: 4, allowedPrivateCidrs: [] },
      {
        pool: { query, connect } as never,
        log,
        keys: {} as never,
        mailer: null,
        registry,
      },
    );
    expect(vi.getTimerCount() - before).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000);
    const sql = query.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(sql.some((s) => s.includes("status = 'sending' AND lease_until"))).toBe(true);
    await loops.stop();
    expect(vi.getTimerCount()).toBe(before);
  });
});
