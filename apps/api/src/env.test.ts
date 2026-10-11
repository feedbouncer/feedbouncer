import { describe, expect, it } from 'vitest';
import { EnvError } from '@feedbouncer/service-runtime';
import { loadApiEnv } from './env.js';

const SECRET = 'dev-only-auth-secret-change-me-0123456789';
const base = {
  DATABASE_URL: 'postgresql://fb:dev-only-pw@postgres:5432/fb',
  REDIS_URL: 'redis://:dev-only-pw@redis:6379/0',
  AUTH_SECRET: SECRET,
  PUBLIC_WEB_URL: 'http://localhost:3000',
  SMTP_URL: 'smtp://mailpit:1025',
};

function without(key: keyof typeof base): Record<string, string> {
  return Object.fromEntries(Object.entries(base).filter(([k]) => k !== key));
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
  it('loads defaults for optional values', () => {
    const env = loadApiEnv(base);
    expect(env.port).toBe(3001);
    expect(env.logLevel).toBe('info');
    expect(env.databaseUrl.hostname).toBe('postgres');
    expect(env.redisUrl.hostname).toBe('redis');
    expect(env.authSecret).toBe(SECRET);
    expect(env.publicWebUrl.origin).toBe('http://localhost:3000');
    expect(env.smtpUrl.hostname).toBe('mailpit');
    expect(env.mailFrom).toBe('FeedBouncer <no-reply@localhost>');
    expect(env.trustProxyHops).toBe(0);
  });

  it('fails naming REDIS_URL, without leaking DATABASE_URL credentials', () => {
    expect(messageOf(() => loadApiEnv(without('REDIS_URL')))).toMatch(/REDIS_URL is not set/);
    expect(messageOf(() => loadApiEnv(without('REDIS_URL')))).not.toContain('dev-only-pw');
  });

  it('rejects a Redis URL given as DATABASE_URL', () => {
    expect(() => loadApiEnv({ ...base, DATABASE_URL: base.REDIS_URL })).toThrow(
      /DATABASE_URL must use one of/,
    );
  });

  describe('AUTH_SECRET', () => {
    it('is required', () => {
      expect(messageOf(() => loadApiEnv(without('AUTH_SECRET')))).toMatch(/AUTH_SECRET is not set/);
    });
    it('needs at least 32 characters and is never echoed', () => {
      const short = 'too-short-secret-31-characters!';
      expect(short).toHaveLength(31);
      const msg = messageOf(() => loadApiEnv({ ...base, AUTH_SECRET: short }));
      expect(msg).toMatch(/AUTH_SECRET must be at least 32 characters/);
      expect(msg).not.toContain(short);
      expect(loadApiEnv({ ...base, AUTH_SECRET: 'x'.repeat(32) }).authSecret).toHaveLength(32);
    });
  });

  describe('PUBLIC_WEB_URL', () => {
    it('is required', () => {
      expect(messageOf(() => loadApiEnv(without('PUBLIC_WEB_URL')))).toMatch(
        /PUBLIC_WEB_URL is not set/,
      );
    });
    it('accepts http and https origins', () => {
      expect(
        loadApiEnv({ ...base, PUBLIC_WEB_URL: 'https://app.example.com' }).publicWebUrl.origin,
      ).toBe('https://app.example.com');
      expect(
        loadApiEnv({ ...base, PUBLIC_WEB_URL: 'https://app.example.com/' }).publicWebUrl.origin,
      ).toBe('https://app.example.com');
    });
    it.each(['ftp://app.example.com', 'javascript:alert(1)'])('rejects the protocol of %s', (v) => {
      expect(messageOf(() => loadApiEnv({ ...base, PUBLIC_WEB_URL: v }))).toMatch(/PUBLIC_WEB_URL/);
    });
    it.each([
      'https://app.example.com/app',
      'https://app.example.com/?x=1',
      'https://app.example.com/#frag',
    ])('rejects %s, which is not an origin', (v) => {
      expect(messageOf(() => loadApiEnv({ ...base, PUBLIC_WEB_URL: v }))).toMatch(
        /PUBLIC_WEB_URL must be an origin only/,
      );
    });
  });

  describe('SMTP_URL', () => {
    it('is required', () => {
      expect(messageOf(() => loadApiEnv(without('SMTP_URL')))).toMatch(/SMTP_URL is not set/);
    });
    it('accepts smtp: and smtps:', () => {
      expect(
        loadApiEnv({ ...base, SMTP_URL: 'smtps://u:p@mail.example.com:465' }).smtpUrl.protocol,
      ).toBe('smtps:');
    });
    it('rejects other protocols without echoing credentials', () => {
      const msg = messageOf(() => loadApiEnv({ ...base, SMTP_URL: 'http://u:hunter2@mail:25' }));
      expect(msg).toMatch(/SMTP_URL must use one of smtp:, smtps:/);
      expect(msg).not.toContain('hunter2');
    });
  });

  describe('TRUST_PROXY_HOPS', () => {
    it.each([
      ['0', 0],
      ['1', 1],
      ['5', 5],
    ])('accepts %s', (raw, n) => {
      expect(loadApiEnv({ ...base, TRUST_PROXY_HOPS: raw }).trustProxyHops).toBe(n);
    });
    it.each(['6', '-1', 'true', '1.5'])('rejects %s', (raw) => {
      expect(messageOf(() => loadApiEnv({ ...base, TRUST_PROXY_HOPS: raw }))).toMatch(
        /TRUST_PROXY_HOPS must be an integer between 0 and 5/,
      );
    });
  });

  describe('MAIL_FROM', () => {
    it('accepts a custom single-line sender', () => {
      expect(loadApiEnv({ ...base, MAIL_FROM: 'Acme <noreply@acme.test>' }).mailFrom).toBe(
        'Acme <noreply@acme.test>',
      );
    });
    it('rejects more than 200 characters', () => {
      expect(messageOf(() => loadApiEnv({ ...base, MAIL_FROM: 'a'.repeat(201) }))).toMatch(
        /MAIL_FROM/,
      );
      expect(loadApiEnv({ ...base, MAIL_FROM: 'a'.repeat(200) }).mailFrom).toHaveLength(200);
    });
    it.each(['a\nBcc: x@y.test', 'a\rb'])('rejects CR/LF in %j', (v) => {
      expect(messageOf(() => loadApiEnv({ ...base, MAIL_FROM: v }))).toMatch(/MAIL_FROM/);
    });
  });
});
