import { describe, expect, it } from 'vitest';
import { createLogger } from '@feedbouncer/service-runtime';
import { randomKeyEntry } from '@feedbouncer/secrets/testing';
import { loadWorkerEnv } from './env.js';
import { logConfigurationLoaded, reportStartupFailure } from './startup.js';

describe('reportStartupFailure', () => {
  it('logs the error and its cause without credentials', () => {
    const lines: string[] = [];
    const log = createLogger('worker', 'error', (l) => lines.push(l));
    const cause = new Error('connect failed for postgresql://fb:s3cret-pw@postgres:5432/fb');
    reportStartupFailure(log, new Error('Dependencies not ready after 60000ms', { cause }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('s3cret-pw');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'error',
      msg: 'startup failed',
      errorMessage: 'Dependencies not ready after 60000ms',
      causeMessage: expect.stringContaining('postgres:5432'),
    });
  });

  it('handles errors without a cause', () => {
    const lines: string[] = [];
    const log = createLogger('worker', 'error', (l) => lines.push(l));
    reportStartupFailure(log, 'boom');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ msg: 'startup failed', error: 'NonError' });
  });

  it('logs a null cause for an Error without one', () => {
    const lines: string[] = [];
    const log = createLogger('worker', 'error', (l) => lines.push(l));
    reportStartupFailure(log, new Error('boom'));
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      errorMessage: 'boom',
      cause: null,
      causeCode: null,
      causeMessage: null,
    });
  });
});

describe('logConfigurationLoaded', () => {
  it('logs the active key id readably and no key material', () => {
    const entry = randomKeyEntry('k2026b');
    const env = loadWorkerEnv(
      {
        FB_ENV: 'production',
        DATABASE_URL: 'postgresql://fb:dev-only-pw@postgres:5432/fb',
        REDIS_URL: 'redis://:dev-only-pw@redis:6379/0',
        FB_ENCRYPTION_KEYS: entry,
        FB_ENCRYPTION_ACTIVE_KEY_ID: 'k2026b',
      },
      { warn: () => {} },
    );
    const lines: string[] = [];
    logConfigurationLoaded(
      createLogger('worker', 'info', (l) => lines.push(l)),
      env,
    );
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      msg: 'configuration loaded',
      activeKeyId: 'k2026b',
    });
    expect(lines[0]).not.toContain(entry.split(':')[1]);
  });
});
