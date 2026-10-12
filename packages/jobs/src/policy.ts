export interface RetryPolicy {
  /** Total runs allowed for retryable failures (and crashes). 1..50 */
  readonly maxAttempts: number;
  /** First retry delay before jitter. 100..600_000 */
  readonly baseDelayMs: number;
  /** Ceiling for one backoff delay. baseDelayMs..86_400_000 */
  readonly maxDelayMs: number;
  /** Rate-limit deferrals allowed (they do not count as failures). 0..1000 */
  readonly maxDeferrals: number;
  /** Total time a job may spend deferred by rate limits. 0..604_800_000 */
  readonly maxDeferredMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 8,
  baseDelayMs: 5_000,
  maxDelayMs: 900_000,
  maxDeferrals: 100,
  maxDeferredMs: 86_400_000,
});
export const DEFAULT_TIMEOUT_MS = 60_000;
export const LEASE_MARGIN_MS = 30_000;

const int = (n: unknown, min: number, max: number) =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;

export function validatePolicy(p: RetryPolicy): RetryPolicy {
  const bad = (f: string): never => {
    throw new RangeError(`Invalid retry policy: ${f}`);
  };
  if (!int(p.maxAttempts, 1, 50)) bad('maxAttempts');
  if (!int(p.baseDelayMs, 100, 600_000)) bad('baseDelayMs');
  if (!int(p.maxDelayMs, p.baseDelayMs, 86_400_000)) bad('maxDelayMs');
  if (!int(p.maxDeferrals, 0, 1_000)) bad('maxDeferrals');
  if (!int(p.maxDeferredMs, 0, 604_800_000)) bad('maxDeferredMs');
  return Object.freeze({ ...p });
}

export function resolvePolicy(
  base: RetryPolicy,
  ...overrides: (Partial<RetryPolicy> | undefined)[]
): RetryPolicy {
  return validatePolicy(Object.assign({}, base, ...overrides.filter(Boolean)));
}

const unit = (r: number) => (Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999999) : 0);

/** failureNumber is 1 for the first failure. Equal jitter: [exp/2, exp]. */
export function backoffDelayMs(
  failureNumber: number,
  p: RetryPolicy,
  random: () => number,
): number {
  const n = Math.max(1, Math.trunc(failureNumber));
  const exp = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** Math.min(n - 1, 40));
  return Math.floor(exp / 2 + unit(random()) * (exp / 2));
}

export const leaseMs = (timeoutMs: number) => timeoutMs + LEASE_MARGIN_MS;

/** Upper bound on how long a job can remain `queued` before it settles. */
export function retryHorizonMs(p: RetryPolicy, timeoutMs: number): number {
  let backoff = 0;
  for (let n = 1; n < p.maxAttempts; n++)
    backoff += Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (n - 1));
  return backoff + p.maxDeferredMs + 2 * p.maxAttempts * leaseMs(timeoutMs);
}
