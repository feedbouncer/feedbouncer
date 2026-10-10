import { withTimeout } from './health.js';

export interface WaitOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly attemptTimeoutMs: number;
  readonly onRetry?: (attempt: number, err: unknown) => void;
}

// Startup tolerance: Compose healthchecks gate startup, but a dependency can
// still blip (e.g. Postgres restart). Retry within a bounded window instead
// of crash-looping, then fail loudly.
export async function waitUntil(check: () => Promise<unknown>, opts: WaitOptions): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let attempt = 0;
  let lastError: unknown;
  for (;;) {
    attempt += 1;
    try {
      await withTimeout(Promise.resolve().then(check), opts.attemptTimeoutMs, 'dependency check');
      return;
    } catch (err) {
      lastError = err;
      opts.onRetry?.(attempt, err);
    }
    if (Date.now() + opts.intervalMs > deadline) {
      throw new Error(`Dependencies not ready after ${opts.timeoutMs}ms (${attempt} attempts)`, {
        cause: lastError,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
}
