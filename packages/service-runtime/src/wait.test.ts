import { describe, expect, it, vi } from 'vitest';
import { waitUntil } from './wait.js';

describe('waitUntil', () => {
  it('resolves once the check succeeds, reporting each retry', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    await waitUntil(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('not yet');
      },
      { timeoutMs: 1_000, intervalMs: 5, attemptTimeoutMs: 100, onRetry },
    );
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('gives up after timeoutMs with the last error as cause', async () => {
    const err = await waitUntil(() => Promise.reject(new Error('refused')), {
      timeoutMs: 30,
      intervalMs: 5,
      attemptTimeoutMs: 10,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not ready after 30ms/);
    expect(((err as Error).cause as Error).message).toBe('refused');
  });

  it('bounds a hanging attempt with attemptTimeoutMs', async () => {
    const started = Date.now();
    await expect(
      waitUntil(() => new Promise(() => {}), {
        timeoutMs: 50,
        intervalMs: 5,
        attemptTimeoutMs: 10,
      }),
    ).rejects.toThrow(/not ready/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
