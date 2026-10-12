import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { redisBudget } from './budget.js';
import type { RateLimitPolicy } from './types.js';

const policy: RateLimitPolicy = {
  points: 4,
  durationSec: 60,
  urgentReservePoints: 1,
  defaultRetryAfterMs: 1_000,
};
let redis: Redis;
let prefix: string;

beforeAll(() => {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL must be set for connector integration tests.');
  redis = new Redis(url, { maxRetriesPerRequest: 1 });
  prefix = `fb:test:${randomUUID()}`;
});
afterAll(async () => {
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
});

const key = (org: string, brand: string, conn: string) => `${org}/${brand}/${conn}`;

describe('redisBudget', () => {
  it('does not share a budget between connections', async () => {
    const budget = redisBudget(redis, prefix);
    const c1 = key('org-1', 'brand-1', randomUUID());
    const c2 = key('org-1', 'brand-1', randomUUID());
    for (let i = 0; i < policy.points; i++)
      expect((await budget.acquire('facebook', c1, policy, 'urgent')).granted).toBe(true);
    expect((await budget.acquire('facebook', c1, policy, 'urgent')).granted).toBe(false);
    expect((await budget.acquire('facebook', c2, policy, 'urgent')).granted).toBe(true);
  });

  it('does not share a budget between tenants using the same connection id', async () => {
    const budget = redisBudget(redis, prefix);
    const conn = randomUUID();
    const t1 = key('org-1', 'brand-1', conn);
    const t2 = key('org-2', 'brand-2', conn);
    for (let i = 0; i < policy.points; i++) await budget.acquire('facebook', t1, policy, 'urgent');
    expect((await budget.acquire('facebook', t1, policy, 'urgent')).granted).toBe(false);
    expect((await budget.acquire('facebook', t2, policy, 'urgent')).granted).toBe(true);
  });

  it('keeps an exhausted budget across RateBudget instances on the same Redis', async () => {
    const c = key('org-1', 'brand-1', randomUUID());
    const first = redisBudget(redis, prefix);
    for (let i = 0; i < policy.points; i++) await first.acquire('facebook', c, policy, 'urgent');
    const secondClient = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
    const d = await redisBudget(secondClient, prefix)
      .acquire('facebook', c, policy, 'urgent')
      .finally(() => secondClient.disconnect());
    expect(d.granted).toBe(false);
    expect(d).toMatchObject({ retryAfterMs: expect.any(Number) });
  });

  it('writes only keys under the configured prefix, naming the full scope', async () => {
    const c = key('org-x', 'brand-x', randomUUID());
    await redisBudget(redis, prefix).acquire('facebook', c, policy, 'bulk');
    const keys = await redis.keys(`${prefix}:*`);
    expect(keys.some((k) => k.includes(c))).toBe(true);
    expect(keys.every((k) => k.startsWith(`${prefix}:`))).toBe(true);
  });
});
