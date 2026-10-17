import { afterEach, describe, expect, it, vi } from 'vitest';
import type { createPool } from '@feedbouncer/db';
import { testKeyring } from '@feedbouncer/secrets/testing';
import { createLogger } from '@feedbouncer/service-runtime';
import { startReportLoops } from './reports.js';

const lines: Array<Record<string, unknown>> = [];
const log = createLogger('test', 'debug', (l) => lines.push(JSON.parse(l)));
const pool = {
  query: async () => {
    throw new Error('no db in unit test');
  },
} as unknown as ReturnType<typeof createPool>;
const deps = {
  pool,
  log,
  keys: testKeyring(['k1']),
  mailer: { send: async () => {} },
  web: new URL('https://app.example.com'),
};

afterEach(() => {
  vi.useRealTimers();
  lines.length = 0;
});

describe('startReportLoops', () => {
  it('disabled → returns null and logs one reports.disabled info line; no error lines', () => {
    expect(startReportLoops({ enabled: false }, { ...deps, mailer: null, web: null })).toBeNull();
    expect(lines.filter((l) => l.msg === 'reports.disabled' && l.level === 'info')).toHaveLength(1);
    expect(lines.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  });

  it('enabled without mailer or web origin → throws', () => {
    expect(() => startReportLoops({ enabled: true }, { ...deps, mailer: null })).toThrow();
    expect(() => startReportLoops({ enabled: true }, { ...deps, web: null })).toThrow();
  });

  it('enabled → stop() clears both timers', () => {
    vi.useFakeTimers();
    const loops = startReportLoops({ enabled: true }, deps);
    expect(loops).not.toBeNull();
    expect(vi.getTimerCount()).toBe(2);
    loops!.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failing tick is logged as reports.tick_failed and the loop keeps running', async () => {
    vi.useFakeTimers();
    const loops = startReportLoops({ enabled: true }, deps)!;
    await vi.advanceTimersByTimeAsync(60_000);
    const failed = lines.filter((l) => l.msg === 'reports.tick_failed').map((l) => l.loop);
    expect(failed).toEqual(expect.arrayContaining(['scheduler', 'dispatch']));
    expect(failed.filter((l) => l === 'dispatch')).toHaveLength(6);
    loops.stop();
  });
});
