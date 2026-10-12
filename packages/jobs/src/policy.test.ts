import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY as D,
  backoffDelayMs,
  leaseMs,
  resolvePolicy,
  retryHorizonMs,
  validatePolicy,
} from './policy.js';

const MIN = () => 0;
const MAX = () => 0.999999;

describe('backoffDelayMs', () => {
  it('is exponential with equal jitter', () => {
    const p = { ...D, baseDelayMs: 1_000, maxDelayMs: 60_000 };
    expect(backoffDelayMs(1, p, MIN)).toBe(500);
    expect(backoffDelayMs(1, p, MAX)).toBeLessThanOrEqual(1_000);
    expect(backoffDelayMs(2, p, MIN)).toBe(1_000);
    expect(backoffDelayMs(3, p, MIN)).toBe(2_000);
  });
  it('below the cap, the next minimum is at least the previous maximum', () => {
    const p = { ...D, baseDelayMs: 1_000, maxDelayMs: 60_000 };
    for (let n = 1; n < 6; n++)
      expect(backoffDelayMs(n + 1, p, MIN)).toBeGreaterThanOrEqual(backoffDelayMs(n, p, MAX));
  });
  it('the minimum never shrinks, even at the cap', () => {
    const p = { ...D, baseDelayMs: 1_000, maxDelayMs: 4_000 };
    for (let n = 1; n < 30; n++)
      expect(backoffDelayMs(n + 1, p, MIN)).toBeGreaterThanOrEqual(backoffDelayMs(n, p, MIN));
  });
  it('caps at maxDelayMs', () => {
    const p = { ...D, baseDelayMs: 1_000, maxDelayMs: 4_000 };
    expect(backoffDelayMs(30, p, MAX)).toBeLessThanOrEqual(4_000);
    expect(backoffDelayMs(30, p, MIN)).toBe(2_000);
  });
  it('clamps a misbehaving random source', () => {
    expect(backoffDelayMs(1, { ...D, baseDelayMs: 1_000 }, () => 7)).toBeLessThanOrEqual(1_000);
    expect(backoffDelayMs(1, { ...D, baseDelayMs: 1_000 }, () => Number.NaN)).toBe(500);
  });
});

describe('policy validation and resolution', () => {
  it('has documented defaults', () => {
    expect(D).toEqual({
      maxAttempts: 8,
      baseDelayMs: 5_000,
      maxDelayMs: 900_000,
      maxDeferrals: 100,
      maxDeferredMs: 86_400_000,
    });
  });
  it('applies overrides left to right (default <- platform <- job type)', () => {
    expect(
      resolvePolicy(D, { maxAttempts: 3 }, undefined, { maxAttempts: 5, baseDelayMs: 100 }),
    ).toMatchObject({ maxAttempts: 5, baseDelayMs: 100 });
  });
  it.each([
    [{ maxAttempts: 0 }, 'maxAttempts'],
    [{ maxAttempts: 51 }, 'maxAttempts'],
    [{ baseDelayMs: 99 }, 'baseDelayMs'],
    [{ baseDelayMs: 10_000, maxDelayMs: 5_000 }, 'maxDelayMs'],
    [{ maxDeferrals: -1 }, 'maxDeferrals'],
    [{ maxDeferredMs: 1.5 }, 'maxDeferredMs'],
  ])('rejects %o', (over, field) => {
    expect(() => validatePolicy({ ...D, ...over })).toThrow(`Invalid retry policy: ${field}`);
  });
});

describe('retryHorizonMs', () => {
  it('bounds the time a job can stay queued', () => {
    const p = {
      ...D,
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 1_500,
      maxDeferredMs: 10_000,
    };
    // backoff caps 1000 + 1500, deferral budget 10000, 2*3 leases of (2000+30000)
    expect(retryHorizonMs(p, 2_000)).toBe(1_000 + 1_500 + 10_000 + 6 * leaseMs(2_000));
  });
  it('default horizon is about a day', () => {
    const h = retryHorizonMs(D, 60_000);
    expect(h).toBeGreaterThan(86_400_000);
    expect(h).toBeLessThan(2 * 86_400_000);
  });
});
