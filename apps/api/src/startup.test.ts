import { describe, expect, it } from 'vitest';
import { createLogger } from '@feedbouncer/service-runtime';
import { randomKeyEntry } from '@feedbouncer/secrets/testing';
import { loadApiEnv } from './env.js';
import { logConfigurationLoaded } from './startup.js';

describe('logConfigurationLoaded', () => {
  it('logs the active key id readably and no key material', () => {
    const entry = randomKeyEntry('k2026b');
    const env = loadApiEnv(
      {
        FB_ENV: 'production',
        DATABASE_URL: 'postgresql://fb:dev-only-pw@postgres:5432/fb',
        REDIS_URL: 'redis://:dev-only-pw@redis:6379/0',
        AUTH_SECRET: 'a-real-looking-auth-secret-0123456789abcdef',
        PUBLIC_WEB_URL: 'http://localhost:3000',
        SMTP_URL: 'smtp://mailpit:1025',
        FB_ENCRYPTION_KEYS: entry,
        FB_ENCRYPTION_ACTIVE_KEY_ID: 'k2026b',
      },
      { warn: () => {} },
    );
    const lines: string[] = [];
    logConfigurationLoaded(
      createLogger('api', 'info', (l) => lines.push(l)),
      env,
    );
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      msg: 'configuration loaded',
      activeKeyId: 'k2026b',
    });
    expect(lines[0]).not.toContain(entry.split(':')[1]);
  });
});
