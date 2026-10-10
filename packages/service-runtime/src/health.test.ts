import { describe, expect, it, vi } from 'vitest';
import { runChecks } from './health.js';

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
