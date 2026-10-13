import { describe, expect, it, vi } from 'vitest';
import { runChecks, TimeoutError, withTimeout } from './health.js';

describe('runChecks', () => {
  it('reports ok when every check resolves', async () => {
    const report = await runChecks(
      { postgres: async () => 1, redis: async () => 'PONG' },
      { timeoutMs: 100 },
    );
    expect(report).toEqual({ status: 'ok', checks: { postgres: 'up', redis: 'up' } });
  });

  it('marks a throwing check down and carries no error text', async () => {
    const report = await runChecks(
      {
        postgres: async () => {
          throw new Error('password authentication failed: hunter2');
        },
        redis: async () => 'PONG',
      },
      { timeoutMs: 100 },
    );
    expect(report).toEqual({ status: 'unavailable', checks: { postgres: 'down', redis: 'up' } });
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });

  it('marks a hanging check down after the timeout', async () => {
    const report = await runChecks({ redis: () => new Promise(() => {}) }, { timeoutMs: 20 });
    expect(report.checks.redis).toBe('down');
  });

  it('reports each failure to onFailure', async () => {
    const onFailure = vi.fn();
    await runChecks({ db: () => Promise.reject(new Error('x')) }, { timeoutMs: 50, onFailure });
    expect(onFailure).toHaveBeenCalledWith('db', expect.any(Error));
  });
});

describe('withTimeout', () => {
  it('rejects with a TimeoutError naming the label when the promise is too slow', async () => {
    const err = await withTimeout(new Promise(() => {}), 20, 'collect').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toBe('collect timed out after 20ms');
  });

  it('passes through the result and the original rejection', async () => {
    await expect(withTimeout(Promise.resolve(7), 50, 'x')).resolves.toBe(7);
    const boom = new Error('boom');
    await expect(withTimeout(Promise.reject(boom), 50, 'x')).rejects.toBe(boom);
  });
});
