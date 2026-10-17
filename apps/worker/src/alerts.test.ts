import { afterEach, describe, expect, it, vi } from 'vitest';
import type { createPool } from '@feedbouncer/db';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { createLogger } from '@feedbouncer/service-runtime';
import { startAlertLoops, type AlertLoopsConfig } from './alerts.js';

const lines: Array<Record<string, unknown>> = [];
const log = createLogger('test', 'debug', (l) => lines.push(JSON.parse(l)));
const pool = {
  query: async () => {
    throw new Error('no db in unit test');
  },
} as unknown as ReturnType<typeof createPool>;
const deps = { pool, log, keys: testKeyring(['k1']), mailer: null };
const config = (slack: boolean, email = false): AlertLoopsConfig => ({
  alerts: { slack, email, capPerHour: 30, emailPerMinute: 60 },
  web: () => new URL('https://app.example.com'),
});

afterEach(() => {
  vi.useRealTimers();
  lines.length = 0;
});

describe('startAlertLoops', () => {
  it('alerts disabled → returns null and logs one alerts.disabled info line; no error lines', () => {
    expect(startAlertLoops(config(false), deps)).toBeNull();
    expect(lines.filter((l) => l.msg === 'alerts.disabled' && l.level === 'info')).toHaveLength(1);
    expect(lines.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  it('enabled → stop() clears all timers', () => {
    vi.useFakeTimers();
    const loops = startAlertLoops(config(true), deps);
    expect(loops).not.toBeNull();
    expect(vi.getTimerCount()).toBe(3);
    loops!.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failing tick is logged as alerts.tick_failed and the loop keeps running', async () => {
    vi.useFakeTimers();
    const loops = startAlertLoops(config(true), deps)!;
    await vi.advanceTimersByTimeAsync(60_000);
    const failed = lines.filter((l) => l.msg === 'alerts.tick_failed').map((l) => l.loop);
    expect(failed).toEqual(expect.arrayContaining(['spike', 'flags', 'dispatch']));
    loops.stop();
  });
});
