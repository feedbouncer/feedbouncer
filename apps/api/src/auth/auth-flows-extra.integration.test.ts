import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import {
  PASSWORD,
  login,
  signUpAndVerify,
  startTestApi,
  type TestApi,
} from '../testing/harness.js';
import { ACCOUNT_DELETION, AUTH } from '../tokens.js';
import { UserDeletionBlockedError, type Auth, type AuthHooks } from './auth.js';

// Separate from auth-flows: each app instance has its own per-IP email-send budget.
let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());
const tick = () => new Promise((r) => setTimeout(r, 20)); // emails are fire-and-forget
const sessionUser = async (cookie: string) =>
  (await api.app.get<Auth>(AUTH).api.getSession({ headers: new Headers({ cookie }) }))?.user ??
  null;

describe('email verification', () => {
  it('GET /verify-email without a token redirects like every other outcome', async () => {
    const r = await api.req('GET', '/api/auth/verify-email');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/verified?error=invalid_token');
  });

  it('ignores a client-supplied callbackURL', async () => {
    await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'cb@x.test', password: PASSWORD, name: 'C' },
    });
    await tick();
    const url = new URL(extractFirstUrl(api.mailer.lastTo('cb@x.test')!.text)!);
    const r = await api.req(
      'GET',
      `${url.pathname}${url.search}&callbackURL=${encodeURIComponent('https://evil.test/')}`,
    );
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/verified');
  });

  it('send-verification-email drops extra fields', async () => {
    await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'sv@x.test', password: PASSWORD, name: 'S' },
    });
    await tick();
    const before = api.mailer.sent.filter((m) => m.to === 'sv@x.test').length;
    const r = await api.req('POST', '/api/auth/send-verification-email', {
      body: { email: 'sv@x.test', callbackURL: 'https://evil.test/', name: 'x' },
    });
    expect(r.status).toBe(200);
    await tick();
    const mails = api.mailer.sent.filter((m) => m.to === 'sv@x.test');
    expect(mails.length).toBe(before + 1);
    expect(JSON.stringify(mails.at(-1))).not.toContain('evil.test');
  });
});

describe('upstream failures', () => {
  it.each([
    ['/api/auth/sign-out', {}],
    ['/api/auth/request-password-reset', { email: 'up@x.test' }],
    ['/api/auth/send-verification-email', { email: 'up@x.test' }],
  ])('%s returns 500 internal_error when Better Auth fails', async (path, body) => {
    const spy = vi
      .spyOn(api.app.get<Auth>(AUTH), 'handler')
      .mockResolvedValueOnce(new Response('{}', { status: 500 }));
    try {
      const r = await api.req('POST', path, { body });
      expect(r.status).toBe(500);
      expect(r.body.error.code).toBe('internal_error');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('delete account', () => {
  it('a wrong password is 401 invalid_credentials and keeps the account', async () => {
    await signUpAndVerify(api, 'delw@x.test');
    const cookie = await login(api, 'delw@x.test');
    const r = await api.req('POST', '/api/auth/delete-user', {
      cookie,
      body: { password: 'bad bad bad bad 1' },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('invalid_credentials');
    expect(await sessionUser(cookie)).not.toBeNull();
  });

  it('a denied deletion is 409 sole_owner', async () => {
    await signUpAndVerify(api, 'del409@x.test');
    const cookie = await login(api, 'del409@x.test');
    const hooks = api.app.get<AuthHooks>(ACCOUNT_DELETION);
    const original = hooks.beforeDeleteUser;
    hooks.beforeDeleteUser = async () => {
      throw new UserDeletionBlockedError();
    };
    try {
      const r = await api.req('POST', '/api/auth/delete-user', {
        cookie,
        body: { password: PASSWORD },
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('sole_owner');
    } finally {
      hooks.beforeDeleteUser = original;
    }
    expect(await sessionUser(cookie)).not.toBeNull();
  });
});
