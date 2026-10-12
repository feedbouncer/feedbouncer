import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateBudget, memoryBudget, type BudgetLimiter } from './budget.js';
import { ConnectorError } from './errors.js';
import type { RateLimitPolicy } from './types.js';

const policy: RateLimitPolicy = {
  points: 10,
  durationSec: 60,
  urgentReservePoints: 3,
  defaultRetryAfterMs: 5_000,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RateBudget', () => {
  it('tracks budgets per connection', async () => {
    const b = memoryBudget();
    for (let i = 0; i < 10; i++)
      expect((await b.acquire('facebook', 'c1', policy, 'urgent')).granted).toBe(true);
    expect((await b.acquire('facebook', 'c1', policy, 'urgent')).granted).toBe(false);
    expect((await b.acquire('facebook', 'c2', policy, 'urgent')).granted).toBe(true);
  });

  it('bulk can never use the urgent reserve, so actions are not starved', async () => {
    const b = memoryBudget();
    let bulk = 0;
    for (let i = 0; i < 20; i++)
      if ((await b.acquire('facebook', 'c1', policy, 'bulk')).granted) bulk++;
    expect(bulk).toBe(7);
    let urgent = 0;
    for (let i = 0; i < 5; i++)
      if ((await b.acquire('facebook', 'c1', policy, 'urgent')).granted) urgent++;
    expect(urgent).toBe(3);
  });

  it('a refused request reports how long to defer, and succeeds after that', async () => {
    const b = memoryBudget();
    for (let i = 0; i < 10; i++) await b.acquire('facebook', 'c1', policy, 'urgent');
    const d = await b.acquire('facebook', 'c1', policy, 'urgent');
    expect(d.granted).toBe(false);
    if (d.granted) return;
    expect(d.retryAfterMs).toBeGreaterThan(0);
    expect(d.retryAfterMs).toBeLessThanOrEqual(60_000);
    vi.advanceTimersByTime(d.retryAfterMs + 1);
    expect((await b.acquire('facebook', 'c1', policy, 'urgent')).granted).toBe(true);
  });

  it('a platform retry hint blocks even when the local budget has room', async () => {
    const b = memoryBudget();
    await b.applyPlatformHint('facebook', 'c1', policy, { retryAfterMs: 30_000 });
    const d = await b.acquire('facebook', 'c1', policy, 'urgent');
    expect(d).toMatchObject({ granted: false });
    if (!d.granted) expect(d.retryAfterMs).toBeGreaterThanOrEqual(29_000);
  });

  it('a quota report lower than the local estimate wins', async () => {
    const b = memoryBudget();
    await b.applyQuotaReport(
      'facebook',
      'c1',
      policy,
      { remaining: 1, resetAt: new Date(Date.now() + 60_000) },
      Date.now(),
    );
    expect((await b.acquire('facebook', 'c1', policy, 'urgent')).granted).toBe(true);
    expect((await b.acquire('facebook', 'c1', policy, 'urgent')).granted).toBe(false);
  });

  it('a quota report of 0 blocks until resetAt', async () => {
    const b = memoryBudget();
    await b.applyQuotaReport(
      'facebook',
      'c1',
      policy,
      { remaining: 0, resetAt: new Date(Date.now() + 20_000) },
      Date.now(),
    );
    expect((await b.acquire('facebook', 'c1', policy, 'urgent')).granted).toBe(false);
  });

  it('fails closed (transient) when the store errors', async () => {
    const broken: BudgetLimiter = {
      consume: async () => {
        throw new Error('ECONNREFUSED');
      },
      reward: async () => undefined,
      penalty: async () => undefined,
      block: async () => undefined,
      get: async () => null,
    };
    const b = new RateBudget(() => broken);
    await expect(b.acquire('facebook', 'c1', policy, 'urgent')).rejects.toMatchObject({
      kind: 'transient',
      code: 'budget_store_unavailable',
    });
    await expect(b.acquire('facebook', 'c1', policy, 'urgent')).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });

  it('clamps platform blocks to at most 24 hours', async () => {
    const blocks: number[] = [];
    const recording: BudgetLimiter = {
      consume: async () => undefined,
      reward: async () => undefined,
      penalty: async () => undefined,
      block: async (_key, secs) => void blocks.push(secs),
      get: async () => null,
    };
    const b = new RateBudget(() => recording);
    const yearMs = 365 * 86_400_000;
    await b.applyQuotaReport(
      'facebook',
      'c1',
      policy,
      { remaining: 0, resetAt: new Date(Date.now() + yearMs) },
      Date.now(),
    );
    await b.applyPlatformHint('facebook', 'c1', policy, { retryAfterMs: yearMs });
    await b.applyPlatformHint('facebook', 'c1', policy, { retryAfterMs: Number.POSITIVE_INFINITY });
    await b.applyPlatformHint('facebook', 'c1', policy, { retryAfterMs: Number.NaN });
    await b.applyPlatformHint('facebook', 'c1', policy, { retryAfterMs: -5_000 });
    expect(blocks).toEqual([86_400, 86_400, 86_400, 1, 1]);
  });

  it('a quota report a year out blocks the account for at most 24 hours', async () => {
    const b = memoryBudget();
    await b.applyQuotaReport(
      'facebook',
      'c1',
      policy,
      { remaining: 0, resetAt: new Date(Date.now() + 365 * 86_400_000) },
      Date.now(),
    );
    const d = await b.acquire('facebook', 'c1', policy, 'urgent');
    expect(d).toMatchObject({ granted: false });
    if (!d.granted) expect(d.retryAfterMs).toBeLessThanOrEqual(86_400_000);
    vi.advanceTimersByTime(86_400_000 + 1);
    expect((await b.acquire('facebook', 'c1', policy, 'urgent')).granted).toBe(true);
  });
});
