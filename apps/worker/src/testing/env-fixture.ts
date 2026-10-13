import { randomKeyEntry } from '@feedbouncer/secrets/testing';
import { loadWorkerEnv, type WorkerEnv } from '../env.js';

/** A valid production-shaped worker environment for tests. */
export function validWorkerEnv(): Record<string, string> {
  return {
    FB_ENV: 'production',
    DATABASE_URL: 'postgresql://fb:dev-only-pw@postgres:5432/fb',
    REDIS_URL: 'redis://:dev-only-pw@redis:6379/0',
    FB_ENCRYPTION_KEYS: randomKeyEntry('k1'),
    FB_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  };
}

export function testWorkerEnv(overrides: Record<string, string> = {}): WorkerEnv {
  return loadWorkerEnv({ ...validWorkerEnv(), ...overrides }, { warn: () => {} });
}
