import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import {
  PASSWORD,
  login,
  signUpAndVerify,
  startTestApi,
  type TestApi,
} from '../testing/harness.js';
import { AUTH } from '../tokens.js';
import type { Auth } from './auth.js';
import { checkPassword } from './password-policy.js';

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());
const tick = () => new Promise((r) => setTimeout(r, 20)); // emails are fire-and-forget
// The session behind a cookie as Better Auth sees it (/api/v1/me arrives with the session guard).
const sessionUser = async (cookie: string) =>
  (await api.app.get<Auth>(AUTH).api.getSession({ headers: new Headers({ cookie }) }))?.user ??
  null;

// 70 code points, 140 UTF-16 units: over Better Auth's default 128-unit limit,
// inside our 128-code-point policy.
const EMOJI_PASSPHRASE = Array.from({ length: 70 }, (_, i) =>
  String.fromCodePoint(0x1f300 + ((i * 37) % 500)),
).join('');

describe('sign-up', () => {
  it('a new and a duplicate email get byte-identical responses; only one account exists', async () => {
    const a = await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'Dup@X.test', password: PASSWORD, name: 'A' },
    });
    const b = await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: '  dup@x.test ', password: PASSWORD, name: 'B' },
    });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.body).toEqual(a.body);
    expect(a.cookie).toBeNull();
    const { rows } = await api.pool.query(
      "SELECT count(*)::int AS n FROM app_user WHERE email = 'dup@x.test'",
    );
    expect(rows[0].n).toBe(1);
    await tick();
    expect(api.mailer.sent.filter((m) => m.to === 'dup@x.test').map((m) => m.subject)).toEqual([
      'Confirm your email for FeedBouncer',
      'You already have a FeedBouncer account',
    ]);
  });

  it('rejects weak and short passwords with 422', async () => {
    const weak = await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'w@x.test', password: 'password1234', name: 'W' },
    });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe('weak_password');
    const short = await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'w@x.test', password: 'short', name: 'W' },
    });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('password_too_short');
  });

  it('rejects unknown fields and non-ASCII emails with 400, never 500', async () => {
    const bad = await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'ä@x.test', password: PASSWORD, name: 'X' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_email');
    const extra = await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'e@x.test', password: PASSWORD, name: 'X', role: 'owner' },
    });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe('invalid_request');
  });

  it('never echoes the password in an error', async () => {
    const r = await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'e@x.test', password: PASSWORD, name: '' },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain(PASSWORD);
  });

  it('accepts a non-BMP passphrase that is long in UTF-16 units and logs in with it', async () => {
    expect(checkPassword(EMOJI_PASSPHRASE, ['emo@x.test'])).toBeNull();
    expect(EMOJI_PASSPHRASE.length).toBeGreaterThan(128);
    const r = await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'emo@x.test', password: EMOJI_PASSPHRASE, name: 'Emo' },
    });
    expect(r.status).toBe(202);
    await tick();
    const url = new URL(extractFirstUrl(api.mailer.lastTo('emo@x.test')!.text)!);
    expect((await api.req('GET', `${url.pathname}${url.search}`)).status).toBe(302);
    await login(api, 'emo@x.test', EMOJI_PASSPHRASE);
  });

  it('concurrent duplicate sign-ups create exactly one account', async () => {
    // Three is the per-address send limit, so none of them is rate limited.
    const rs = await Promise.all(
      Array.from({ length: 3 }, () =>
        api.req('POST', '/api/v1/auth/sign-up', {
          body: { email: 'race@x.test', password: PASSWORD, name: 'R' },
        }),
      ),
    );
    expect(rs.map((r) => r.status)).toEqual([202, 202, 202]);
    const { rows } = await api.pool.query(
      "SELECT count(*)::int AS n FROM app_user WHERE email = 'race@x.test'",
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('login', () => {
  it('unknown email and wrong password are indistinguishable', async () => {
    await signUpAndVerify(api, 'li@x.test');
    const unknown = await api.req('POST', '/api/auth/sign-in/email', {
      body: { email: 'nobody@x.test', password: PASSWORD },
    });
    const wrong = await api.req('POST', '/api/auth/sign-in/email', {
      body: { email: 'li@x.test', password: 'wrong wrong wrong 1' },
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('matches email case-insensitively and never returns the session token in JSON', async () => {
    await signUpAndVerify(api, 'case@x.test');
    const r = await api.req('POST', '/api/auth/sign-in/email', {
      body: { email: '  CASE@X.TEST ', password: PASSWORD },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok' });
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(r.headers['set-cookie'])).toMatch(/SameSite=Lax/i);
  });

  it('ignores a client-supplied client IP header', async () => {
    await signUpAndVerify(api, 'ip@x.test');
    const r = await api.req('POST', '/api/auth/sign-in/email', {
      body: { email: 'ip@x.test', password: PASSWORD },
      headers: { 'x-fb-client-ip': '198.51.100.99' },
    });
    expect(r.status).toBe(200);
    const { rows } = await api.pool.query(
      "SELECT s.ip_address FROM auth_session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'ip@x.test'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ip_address).toBe('127.0.0.1');
  });

  it('unverified users can log in with emailVerified=false', async () => {
    await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'unv@x.test', password: PASSWORD, name: 'U' },
    });
    const cookie = await login(api, 'unv@x.test');
    expect((await sessionUser(cookie))?.emailVerified).toBe(false);
  });

  it('logout ends the session', async () => {
    await signUpAndVerify(api, 'lo@x.test');
    const cookie = await login(api, 'lo@x.test');
    expect((await api.req('POST', '/api/auth/sign-out', { cookie, body: {} })).status).toBe(200);
    expect(await sessionUser(cookie)).toBeNull();
  });

  it('a session past expires_at is rejected', async () => {
    await signUpAndVerify(api, 'exp@x.test');
    const cookie = await login(api, 'exp@x.test');
    await api.pool.query(
      "UPDATE auth_session SET expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM app_user WHERE email = 'exp@x.test')",
    );
    expect(await sessionUser(cookie)).toBeNull();
  });
});

describe('password change and reset', () => {
  it('changing the password invalidates other sessions', async () => {
    await signUpAndVerify(api, 'chg@x.test');
    const s1 = await login(api, 'chg@x.test');
    const s2 = await login(api, 'chg@x.test');
    const r = await api.req('POST', '/api/auth/change-password', {
      cookie: s1,
      body: { currentPassword: PASSWORD, newPassword: 'a brand new long passphrase 5' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok' });
    expect(await sessionUser(s2)).toBeNull();
  });

  it('change-password accepts a non-BMP passphrase and does not count a failure', async () => {
    await signUpAndVerify(api, 'chgemo@x.test');
    const cookie = await login(api, 'chgemo@x.test');
    const r = await api.req('POST', '/api/auth/change-password', {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: EMOJI_PASSPHRASE },
    });
    expect(r.status).toBe(200);
    await login(api, 'chgemo@x.test', EMOJI_PASSPHRASE);
  });

  it('reset-password accepts a non-BMP passphrase', async () => {
    await signUpAndVerify(api, 'rstemo@x.test');
    await api.req('POST', '/api/auth/request-password-reset', { body: { email: 'rstemo@x.test' } });
    await tick();
    const link = extractFirstUrl(api.mailer.lastTo('rstemo@x.test')!.text)!;
    const token = new URL(link).searchParams.get('token')!;
    const r = await api.req('POST', '/api/auth/reset-password', {
      body: { token, newPassword: EMOJI_PASSPHRASE },
    });
    expect(r.status).toBe(200);
    await login(api, 'rstemo@x.test', EMOJI_PASSPHRASE);
  });

  it('reset request is identical for known and unknown emails; link is single-use', async () => {
    await signUpAndVerify(api, 'rst@x.test');
    const known = await api.req('POST', '/api/auth/request-password-reset', {
      body: { email: 'RST@x.test' },
    });
    const unknown = await api.req('POST', '/api/auth/request-password-reset', {
      body: { email: 'ghost@x.test' },
    });
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    await tick();
    const link = extractFirstUrl(api.mailer.lastTo('rst@x.test')!.text)!;
    const token = new URL(link).searchParams.get('token')!;
    const ok = await api.req('POST', '/api/auth/reset-password', {
      body: { token, newPassword: 'reset to this long phrase 8' },
    });
    expect(ok.status).toBe(200);
    const again = await api.req('POST', '/api/auth/reset-password', {
      body: { token, newPassword: 'and again another phrase 9' },
    });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('invalid_or_expired_token');
  });

  it('ignores a client-supplied redirect target (no open redirect)', async () => {
    await signUpAndVerify(api, 'redir@x.test');
    await api.req('POST', '/api/auth/request-password-reset', {
      body: { email: 'redir@x.test', redirectTo: 'https://evil.test/' },
    });
    await tick();
    expect(api.mailer.lastTo('redir@x.test')!.text).not.toContain('evil.test');
  });
});

describe('proxy allowlist', () => {
  it.each([
    '/api/auth/list-sessions',
    '/api/auth/update-user',
    '/api/auth/sign-up/email',
    '/api/auth/get-session',
  ])('%s is not exposed', async (path) => {
    expect((await api.req('POST', path, { body: {} })).status).toBe(404);
  });
});

describe('logging', () => {
  it('no log line contains a password', () => {
    expect(api.logLines.length).toBeGreaterThan(0);
    const all = api.logLines.join('\n');
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(EMOJI_PASSPHRASE);
  });
});
