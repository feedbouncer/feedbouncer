import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PASSWORD,
  login,
  signUpAndVerify,
  startTestApi,
  type TestApi,
} from '../testing/harness.js';
import { AUTH } from '../tokens.js';
import type { Auth } from './auth.js';

// A fresh app (and Redis key prefix) per test: IP counters must not leak.
let api: TestApi;
beforeEach(async () => {
  api = await startTestApi();
});
afterEach(() => api.close());

const signIn = (email: string, password: string) =>
  api.req('POST', '/api/auth/sign-in/email', { body: { email, password } });

describe('login rate limits', () => {
  it('locks an account after 5 failures even with the right password, without revealing existence', async () => {
    await signUpAndVerify(api, 'rl@x.test');
    for (let i = 0; i < 5; i++) {
      expect((await signIn('rl@x.test', 'bad bad bad bad 1')).status).toBe(401);
    }
    expect((await signIn('rl@x.test', PASSWORD)).status).toBe(429);
    for (let i = 0; i < 5; i++) await signIn('ghost2@x.test', 'x'.repeat(12));
    expect((await signIn('ghost2@x.test', 'x'.repeat(12))).status).toBe(429);
  });

  it('a successful login resets the account counter', async () => {
    await signUpAndVerify(api, 'reset@x.test');
    for (let i = 0; i < 4; i++) await signIn('reset@x.test', 'bad bad bad bad 1');
    expect((await signIn('reset@x.test', PASSWORD)).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect((await signIn('reset@x.test', 'bad bad bad bad 1')).status).toBe(401);
    }
  });

  it('limits per source IP across accounts', async () => {
    for (let i = 0; i < 20; i++) await signIn(`ip${i}@x.test`, 'x'.repeat(12));
    expect((await signIn('ip99@x.test', 'x'.repeat(12))).status).toBe(429);
  });

  it('a parallel burst of wrong passwords cannot exceed the per-account limit', async () => {
    await signUpAndVerify(api, 'burst@x.test');
    const handler = vi.spyOn(api.app.get<Auth>(AUTH), 'handler');
    const rs = await Promise.all(
      Array.from({ length: 15 }, () => signIn('burst@x.test', 'bad bad bad bad 1')),
    );
    expect(handler).toHaveBeenCalledTimes(5); // only 5 reached the password check
    expect(rs.filter((r) => r.status === 401)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(10);
    expect((await signIn('burst@x.test', PASSWORD)).status).toBe(429);
  });

  it('a parallel burst across accounts cannot exceed the per-IP limit', async () => {
    const handler = vi.spyOn(api.app.get<Auth>(AUTH), 'handler');
    const rs = await Promise.all(
      Array.from({ length: 30 }, (_, i) => signIn(`pb${i}@x.test`, 'x'.repeat(12))),
    );
    expect(handler).toHaveBeenCalledTimes(20);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(10);
  });

  it('a parallel burst of wrong current passwords on change-password is limited too', async () => {
    await signUpAndVerify(api, 'cpb@x.test');
    const cookie = await login(api, 'cpb@x.test');
    const handler = vi.spyOn(api.app.get<Auth>(AUTH), 'handler');
    const rs = await Promise.all(
      Array.from({ length: 12 }, () =>
        api.req('POST', '/api/auth/change-password', {
          cookie,
          body: { currentPassword: 'bad bad bad bad 1', newPassword: 'another long phrase 77' },
        }),
      ),
    );
    expect(handler.mock.calls.length).toBe(5);
    expect(rs.filter((r) => r.status === 429).length).toBe(7);
  });

  it('successful logins do not exhaust the per-IP budget', async () => {
    await signUpAndVerify(api, 'many@x.test');
    for (let i = 0; i < 25; i++) {
      expect((await signIn('many@x.test', PASSWORD)).status).toBe(200);
    }
  });

  it('keeps no raw email in Redis', async () => {
    await signIn('plain@x.test', 'x'.repeat(12));
    const keys = await api.deps.redis.keys(`${api.deps.redisKeyPrefix}*`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join('\n')).not.toContain('plain@x.test');
  });
});

describe('email send rate limits', () => {
  it('limits email sends to 3 per address per hour', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await api.req('POST', '/api/auth/request-password-reset', {
        body: { email: 'bomb@x.test' },
      });
      expect(r.status).toBe(200);
    }
    const r = await api.req('POST', '/api/auth/request-password-reset', {
      body: { email: 'bomb@x.test' },
    });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
  });
});

describe('without Redis', () => {
  it('fails closed for sign-up and email-sending endpoints', async () => {
    const broken = await startTestApi({ redisUrl: new URL('redis://127.0.0.1:1/0') });
    try {
      const up = await broken.req('POST', '/api/v1/auth/sign-up', {
        body: { email: 'a@x.test', password: PASSWORD, name: 'A' },
      });
      expect(up.status).toBe(503);
      for (const path of [
        '/api/auth/request-password-reset',
        '/api/auth/send-verification-email',
      ]) {
        const r = await broken.req('POST', path, { body: { email: 'a@x.test' } });
        expect(r.status).toBe(503);
      }
    } finally {
      await broken.close();
    }
  });

  it('fails closed', async () => {
    const broken = await startTestApi({ redisUrl: new URL('redis://127.0.0.1:1/0') });
    try {
      const r = await broken.req('POST', '/api/auth/sign-in/email', {
        body: { email: 'a@x.test', password: PASSWORD },
      });
      expect(r.status).toBe(503);
    } finally {
      await broken.close();
    }
  });
});
