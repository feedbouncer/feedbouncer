import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import { randomKeyEntry } from '@feedbouncer/secrets/testing';
import { loadWorkerEnv } from './env.js';

const base = {
  FB_ENV: 'production',
  DATABASE_URL: 'postgresql://fb:dev-only-pw@postgres:5432/fb',
  REDIS_URL: 'redis://:dev-only-pw@redis:6379/0',
  FB_ENCRYPTION_KEYS: randomKeyEntry('k1'),
  FB_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
};
const opts = { warn: () => {} };
const load = (env: Record<string, string | undefined>) => loadWorkerEnv(env, opts);

function without(...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !names.includes(k)));
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EnvError);
    return (err as Error).message;
  }
  throw new Error('expected an EnvError');
}

describe('loadWorkerEnv', () => {
  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => load({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('applies defaults', () => {
    expect(load(base)).toMatchObject({
      appEnv: 'production',
      concurrency: 4,
      healthPort: 3002,
      logLevel: 'info',
    });
    expect(load(base).encryption.activeKeyId).toBe('k1');
  });
  it('loads job queue settings and keeps them in the redacted summary', () => {
    const env = load({ ...base, JOB_CONCURRENCY_FACEBOOK: '3', JOB_DLQ_RETENTION_DAYS: '7' });
    expect(env.jobs.concurrency.facebook).toBe(3);
    expect(env.jobs.dlqRetentionMs).toBe(7 * 86_400_000);
    expect(JSON.stringify(env)).toContain('"jobQueuePrefix":"fb"');
  });
  it('fails fast on an invalid job setting', () => {
    expect(() => load({ ...base, JOB_MAX_ATTEMPTS: '0' })).toThrow(/JOB_MAX_ATTEMPTS/);
  });
  it('loads telemetry config with the worker metrics port default', () => {
    expect(load(base).telemetry.metrics.port).toBe(9465);
    expect(load(base).telemetry.metrics.host).toBe('127.0.0.1');
  });
  it('rejects an invalid OTEL_TRACES_EXPORTER', () => {
    expect(() => load({ ...base, OTEL_TRACES_EXPORTER: 'bogus' })).toThrow(/OTEL_TRACES_EXPORTER/);
  });
  it('never reads OTLP headers into config', () => {
    const env = load({ ...base, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer s3cret' });
    expect(JSON.stringify(env)).not.toContain('s3cret');
    expect(inspect(env, { depth: 10 })).not.toContain('s3cret');
  });
  it('bounds WORKER_CONCURRENCY', () => {
    expect(() => load({ ...base, WORKER_CONCURRENCY: '0' })).toThrow(/WORKER_CONCURRENCY/);
    expect(() => load({ ...base, WORKER_CONCURRENCY: '65' })).toThrow(/WORKER_CONCURRENCY/);
  });
  it('requires both URLs', () => {
    expect(() => load(without('DATABASE_URL'))).toThrow(/DATABASE_URL is not set/);
  });
  it('never echoes credentials from a malformed URL', () => {
    const attempt = () => load({ ...base, REDIS_URL: 'http://:dev-only-pw@redis:6379' });
    expect(attempt).toThrow(/REDIS_URL/);
    expect(attempt).not.toThrow(/dev-only-pw/);
  });
  it('refuses to boot in production without encryption keys', () => {
    expect(messageOf(() => load(without('FB_ENCRYPTION_KEYS')))).toMatch(
      /FB_ENCRYPTION_KEYS is not set/,
    );
  });
  it('defaults to production rules when FB_ENV is unset', () => {
    const dbUrl = 'postgresql://feedbouncer:dev-only-postgres-password@postgres:5432/feedbouncer';
    const msg = messageOf(() => load({ ...without('FB_ENV'), DATABASE_URL: dbUrl }));
    expect(msg).toMatch(/DATABASE_URL is set to a documented example value/);
    expect(msg).not.toContain('dev-only-postgres-password');
  });
  it('a whole-config dump contains no connection passwords or key material', () => {
    const entry = randomKeyEntry('k1');
    const env = load({
      ...base,
      DATABASE_URL: 'postgresql://u:sentinel-db-pw-123@db:5432/x',
      REDIS_URL: 'redis://:sentinel-redis-pw-456@redis:6379/0',
      FB_ENCRYPTION_KEYS: entry,
    });
    const material = entry.slice(3);
    for (const out of [JSON.stringify(env), inspect(env, { depth: 10, showHidden: true })]) {
      for (const s of ['sentinel-db-pw-123', 'sentinel-redis-pw-456', material])
        expect(out).not.toContain(s);
    }
    expect(env.databaseUrl.password).toBe('sentinel-db-pw-123');
  });
});
