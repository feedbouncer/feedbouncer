import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import { randomKeyEntry } from '@feedbouncer/secrets/testing';
import { loadApiEnv } from './env.js';

const SECRET = 'a-real-looking-auth-secret-0123456789abcdef';
const KEY = randomKeyEntry('k1');
const base = {
  FB_ENV: 'production',
  DATABASE_URL: 'postgresql://feedbouncer:real-pw-123@postgres:5432/feedbouncer',
  REDIS_URL: 'redis://:dev-only-pw@redis:6379/0',
  AUTH_SECRET: SECRET,
  PUBLIC_WEB_URL: 'http://localhost:3000',
  SMTP_URL: 'smtp://mailpit:1025',
  FB_ENCRYPTION_KEYS: KEY,
  FB_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
};
const opts = { warn: () => {} };
const load = (env: Record<string, string | undefined>) => loadApiEnv(env, opts);

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

describe('loadApiEnv', () => {
  it('loads telemetry and health policy with the api metrics port default', () => {
    const env = load(base);
    expect(env.telemetry.metrics.port).toBe(9464);
    expect(env.telemetry.metrics.host).toBe('127.0.0.1');
    expect(env.telemetry.traces.exporter).toBe('none');
    expect(env.health.failuresDegraded).toBe(3);
  });

  it('rejects an invalid OTEL_TRACES_EXPORTER', () => {
    expect(() => load({ ...base, OTEL_TRACES_EXPORTER: 'jaeger' })).toThrow(/OTEL_TRACES_EXPORTER/);
  });

  it('does not serialise OTLP headers', () => {
    const env = load({ ...base, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer sentinel-otlp' });
    expect(JSON.stringify(env)).not.toContain('sentinel-otlp');
  });

  it('loads defaults for optional values', () => {
    const env = load(base);
    expect(env.port).toBe(3001);
    expect(env.logLevel).toBe('info');
    expect(env.databaseUrl.hostname).toBe('postgres');
    expect(env.redisUrl.hostname).toBe('redis');
    expect(env.authSecret.reveal()).toBe(SECRET);
    expect(env.publicWebUrl.origin).toBe('http://localhost:3000');
    expect(env.smtpUrl.hostname).toBe('mailpit');
    expect(env.mailFrom).toBe('FeedBouncer <no-reply@localhost>');
    expect(env.trustProxyHops).toBe(0);
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => load({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('fails naming REDIS_URL, without leaking DATABASE_URL credentials', () => {
    expect(messageOf(() => load(without('REDIS_URL')))).toMatch(/REDIS_URL is not set/);
    expect(messageOf(() => load(without('REDIS_URL')))).not.toContain('dev-only-pw');
  });

  it('rejects a Redis URL given as DATABASE_URL', () => {
    expect(() => load({ ...base, DATABASE_URL: base.REDIS_URL })).toThrow(
      /DATABASE_URL must use one of/,
    );
  });

  describe('AUTH_SECRET', () => {
    it('is required', () => {
      expect(messageOf(() => load(without('AUTH_SECRET')))).toMatch(/AUTH_SECRET is not set/);
    });
    it('needs at least 32 characters and is never echoed', () => {
      const short = 'too-short-secret-31-characters!';
      expect(short).toHaveLength(31);
      const msg = messageOf(() => load({ ...base, AUTH_SECRET: short }));
      expect(msg).toMatch(/AUTH_SECRET must be at least 32 characters/);
      expect(msg).not.toContain(short);
      expect(load({ ...base, AUTH_SECRET: 'x'.repeat(32) }).authSecret.reveal()).toHaveLength(32);
    });
  });

  describe('PUBLIC_WEB_URL', () => {
    it('is required', () => {
      expect(messageOf(() => load(without('PUBLIC_WEB_URL')))).toMatch(/PUBLIC_WEB_URL is not set/);
    });
    it('accepts http and https origins', () => {
      expect(load({ ...base, PUBLIC_WEB_URL: 'https://app.example.com' }).publicWebUrl.origin).toBe(
        'https://app.example.com',
      );
      expect(
        load({ ...base, PUBLIC_WEB_URL: 'https://app.example.com/' }).publicWebUrl.origin,
      ).toBe('https://app.example.com');
    });
    it.each(['ftp://app.example.com', 'javascript:alert(1)'])('rejects the protocol of %s', (v) => {
      expect(messageOf(() => load({ ...base, PUBLIC_WEB_URL: v }))).toMatch(/PUBLIC_WEB_URL/);
    });
    it.each([
      'https://app.example.com/app',
      'https://app.example.com/?x=1',
      'https://app.example.com/#frag',
    ])('rejects %s, which is not an origin', (v) => {
      expect(messageOf(() => load({ ...base, PUBLIC_WEB_URL: v }))).toMatch(
        /PUBLIC_WEB_URL must be an origin only/,
      );
    });
  });

  describe('SMTP_URL', () => {
    it('is required', () => {
      expect(messageOf(() => load(without('SMTP_URL')))).toMatch(/SMTP_URL is not set/);
    });
    it('accepts smtp: and smtps:', () => {
      expect(load({ ...base, SMTP_URL: 'smtps://u:p@mail.example.com:465' }).smtpUrl.protocol).toBe(
        'smtps:',
      );
    });
    it('rejects other protocols without echoing credentials', () => {
      const msg = messageOf(() => load({ ...base, SMTP_URL: 'http://u:hunter2@mail:25' }));
      expect(msg).toMatch(/SMTP_URL must use one of smtp:, smtps:/);
      expect(msg).not.toContain('hunter2');
    });
  });

  describe('facebook and jobs', () => {
    const facebook = {
      FACEBOOK_APP_ID: '1234567890',
      FACEBOOK_APP_SECRET: 'sentinel-fb-app-secret-0123456789',
      FACEBOOK_WEBHOOK_VERIFY_TOKEN: 'sentinel-fb-verify-token-0123456789',
    };
    it('leaves facebook null when FACEBOOK_APP_ID is unset', () => {
      expect(load(base).facebook).toBeNull();
    });
    it('parses a full facebook config and the job queue prefix', () => {
      const env = load({ ...base, ...facebook, JOB_QUEUE_PREFIX: 'jobs' });
      expect(env.facebook?.appId).toBe('1234567890');
      expect(env.facebook?.appSecret.reveal()).toBe(facebook.FACEBOOK_APP_SECRET);
      expect(env.jobs.prefix).toBe('jobs');
    });
    it('fails fast on a partial facebook config', () => {
      expect(() => load({ ...base, FACEBOOK_APP_ID: '1234567890' })).toThrow(/FACEBOOK_APP_SECRET/);
    });
    it('honours FACEBOOK_APP_SECRET_FILE', () => {
      const fs = { size: () => 29, read: () => 'file-secret-0123456789abcdef\n' };
      const env = loadApiEnv(
        {
          ...base,
          ...facebook,
          FACEBOOK_APP_SECRET: undefined,
          FACEBOOK_APP_SECRET_FILE: '/run/s',
        },
        { warn: () => {}, fs },
      );
      expect(env.facebook?.appSecret.reveal()).toBe('file-secret-0123456789abcdef');
    });
    it('never serializes the facebook secrets', () => {
      const env = load({ ...base, ...facebook });
      for (const out of [JSON.stringify(env), inspect(env, { depth: 10, showHidden: true })]) {
        expect(out).not.toContain(facebook.FACEBOOK_APP_SECRET);
        expect(out).not.toContain(facebook.FACEBOOK_WEBHOOK_VERIFY_TOKEN);
      }
    });
  });

  describe('TRUST_PROXY_HOPS', () => {
    it.each([
      ['0', 0],
      ['1', 1],
      ['5', 5],
    ])('accepts %s', (raw, n) => {
      expect(load({ ...base, TRUST_PROXY_HOPS: raw }).trustProxyHops).toBe(n);
    });
    it.each(['6', '-1', 'true', '1.5'])('rejects %s', (raw) => {
      expect(messageOf(() => load({ ...base, TRUST_PROXY_HOPS: raw }))).toMatch(
        /TRUST_PROXY_HOPS must be an integer between 0 and 5/,
      );
    });
  });

  describe('MAIL_FROM', () => {
    it('accepts a custom single-line sender', () => {
      expect(load({ ...base, MAIL_FROM: 'Acme <noreply@acme.test>' }).mailFrom).toBe(
        'Acme <noreply@acme.test>',
      );
    });
    it('rejects more than 200 characters', () => {
      expect(messageOf(() => load({ ...base, MAIL_FROM: 'a'.repeat(201) }))).toMatch(/MAIL_FROM/);
      expect(load({ ...base, MAIL_FROM: 'a'.repeat(200) }).mailFrom).toHaveLength(200);
    });
    it.each(['a\nBcc: x@y.test', 'a\rb'])('rejects CR/LF in %j', (v) => {
      expect(messageOf(() => load({ ...base, MAIL_FROM: v }))).toMatch(/MAIL_FROM/);
    });
  });
});

describe('secrets configuration', () => {
  it('loads the keyring and app environment', () => {
    const env = load(base);
    expect(env.appEnv).toBe('production');
    expect(env.encryption.activeKeyId).toBe('k1');
  });

  it('refuses to boot in production without encryption keys', () => {
    expect(messageOf(() => load(without('FB_ENCRYPTION_KEYS')))).toMatch(
      /FB_ENCRYPTION_KEYS is not set/,
    );
  });

  it('defaults to production rules when FB_ENV is unset', () => {
    const msg = messageOf(() =>
      load({ ...without('FB_ENV'), AUTH_SECRET: 'dev-only-auth-secret-change-me-0123456789' }),
    );
    expect(msg).toMatch(/AUTH_SECRET is set to a documented example value/);
    expect(msg).not.toContain('dev-only-auth-secret');
  });

  it('refuses placeholder DB passwords in production but only warns in development', () => {
    const dbUrl = 'postgresql://feedbouncer:dev-only-postgres-password@postgres:5432/feedbouncer';
    expect(messageOf(() => load({ ...base, DATABASE_URL: dbUrl }))).toMatch(
      /DATABASE_URL is set to a documented example value/,
    );
    const warnings: string[] = [];
    loadApiEnv(
      { ...base, FB_ENV: 'development', DATABASE_URL: dbUrl },
      { warn: (m) => warnings.push(m) },
    );
    expect(warnings.join('\n')).toMatch(/DATABASE_URL uses a documented example value/);
    expect(warnings.join('\n')).not.toContain('dev-only-postgres-password');
  });

  it('reads AUTH_SECRET and FB_ENCRYPTION_KEYS from mounted files', () => {
    const files: Record<string, string> = {
      '/run/secrets/auth': `${SECRET}\n`,
      '/run/secrets/keys': `${KEY}\n`,
    };
    const fs = {
      size: (p: string) => Buffer.byteLength(files[p]!),
      read: (p: string) => files[p]!,
    };
    const env = loadApiEnv(
      {
        ...without('AUTH_SECRET', 'FB_ENCRYPTION_KEYS'),
        AUTH_SECRET_FILE: '/run/secrets/auth',
        FB_ENCRYPTION_KEYS_FILE: '/run/secrets/keys',
      },
      { warn: () => {}, fs },
    );
    expect(env.authSecret.reveal()).toBe(SECRET);
    expect(env.encryption.activeKeyId).toBe('k1');
  });
});
