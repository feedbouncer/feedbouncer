import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import { createScanRateLimits } from './scan-rate-limit.js';

let redis: Redis;
let prefix: string;
beforeAll(() => {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL must be set');
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
});
afterEach(async () => {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
});
afterAll(() => redis.quit());

const code = async (p: Promise<void>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ApiError ? `${e.status} ${e.code}` : 'other';
  }
};

describe('createScan', () => {
  it('limits a Page to 3 scans a day without burning the other counters', async () => {
    prefix = `fbtest:${randomUUID()}:`;
    const l = createScanRateLimits(redis, prefix);
    const k = (i: number) => ({
      ip: '203.0.113.7',
      visitorId: `v${i}`,
      fbUserHash: `u${i}`,
      pageId: '1234567890',
    });
    for (let i = 0; i < 3; i++) expect(await code(l.createScan(k(i)))).toBe('ok');
    expect(await code(l.createScan(k(3)))).toBe('429 rate_limited');
    expect(await code(l.createScan(k(4)))).toBe('429 rate_limited');
    // The two refused attempts did not count against the IP's 5 a day.
    expect(await code(l.createScan({ ...k(5), pageId: '42' }))).toBe('ok');
    expect(await code(l.createScan({ ...k(6), pageId: '43' }))).toBe('ok');
    expect(await code(l.createScan({ ...k(7), pageId: '44' }))).toBe('429 rate_limited');
  });

  it('limits a visitor to 3 scans a day and stores no raw ids', async () => {
    prefix = `fbtest:${randomUUID()}:`;
    const l = createScanRateLimits(redis, prefix);
    const k = (i: number) => ({
      ip: `198.51.100.${i}`,
      visitorId: 'visitor-raw-id',
      fbUserHash: `u${i}`,
      pageId: `${i}`,
    });
    for (let i = 0; i < 3; i++) expect(await code(l.createScan(k(i)))).toBe('ok');
    expect(await code(l.createScan(k(3)))).toBe('429 rate_limited');
    const keys = await redis.keys(`${prefix}*`);
    expect(keys.every((key) => key.startsWith(`${prefix}rl:scan_`))).toBe(true);
    expect(keys.join(' ')).not.toContain('visitor-raw-id');
  });
});
