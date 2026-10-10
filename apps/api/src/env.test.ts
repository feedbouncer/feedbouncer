import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://fb:dev-only-pw@postgres:5432/fb',
  REDIS_URL: 'redis://:dev-only-pw@redis:6379/0',
};

describe('loadApiEnv', () => {
  it('loads defaults for optional values', () => {
    const env = loadApiEnv(base);
    expect(env.port).toBe(3001);
    expect(env.logLevel).toBe('info');
    expect(env.databaseUrl.hostname).toBe('postgres');
    expect(env.redisUrl.hostname).toBe('redis');
  });

  it('fails naming REDIS_URL, without leaking DATABASE_URL credentials', () => {
    expect(() => loadApiEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(/REDIS_URL is not set/);
    try {
      loadApiEnv({ DATABASE_URL: base.DATABASE_URL });
    } catch (err) {
      expect((err as Error).message).not.toContain('dev-only-pw');
    }
  });

  it('rejects a Redis URL given as DATABASE_URL', () => {
    expect(() => loadApiEnv({ ...base, DATABASE_URL: base.REDIS_URL })).toThrow(
      /DATABASE_URL must use one of/,
    );
  });
});
