import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://fb:dev-only-pw@postgres:5432/fb',
  REDIS_URL: 'redis://:dev-only-pw@redis:6379/0',
};

describe('loadWorkerEnv', () => {
  it('applies defaults', () => {
    expect(loadWorkerEnv(base)).toMatchObject({
      concurrency: 4,
      healthPort: 3002,
      logLevel: 'info',
    });
  });
  it('bounds WORKER_CONCURRENCY', () => {
    expect(() => loadWorkerEnv({ ...base, WORKER_CONCURRENCY: '0' })).toThrow(/WORKER_CONCURRENCY/);
    expect(() => loadWorkerEnv({ ...base, WORKER_CONCURRENCY: '65' })).toThrow(
      /WORKER_CONCURRENCY/,
    );
  });
  it('requires both URLs', () => {
    expect(() => loadWorkerEnv({ REDIS_URL: base.REDIS_URL })).toThrow(/DATABASE_URL is not set/);
  });
  it('never echoes credentials from a malformed URL', () => {
    const attempt = () => loadWorkerEnv({ ...base, REDIS_URL: 'http://:dev-only-pw@redis:6379' });
    expect(attempt).toThrow(/REDIS_URL/);
    expect(attempt).not.toThrow(/dev-only-pw/);
  });
});
