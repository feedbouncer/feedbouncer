import { afterEach, describe, expect, it, vi } from 'vitest';
import type { createPool } from '@feedbouncer/db';
import { createLogger } from '@feedbouncer/service-runtime';
import { startIdempotencyPurge } from './idempotency.js';

const lines: Array<Record<string, unknown>> = [];
const log = createLogger('test', 'debug', (l) => lines.push(JSON.parse(l)));
const HOUR_MS = 3_600_000;

afterEach(() => {
  vi.useRealTimers();
  lines.length = 0;
});

describe('startIdempotencyPurge', () => {
  it('purges expired records hourly and stop() clears the timer', async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => ({ rowCount: 0 }));
    const loop = startIdempotencyPurge({ pool: { query } as never, log });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    expect(query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String((query.mock.calls[0] as unknown[])[0])).toContain('api_idempotency_record');
    loop.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failing purge is logged as idempotency.purge_failed and the loop keeps running', async () => {
    vi.useFakeTimers();
    const pool = {
      query: async () => {
        throw new Error('no db in unit test');
      },
    } as unknown as ReturnType<typeof createPool>;
    const loop = startIdempotencyPurge({ pool, log });
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(lines.filter((l) => l.msg === 'idempotency.purge_failed')).toHaveLength(2);
    loop.stop();
  });
});
