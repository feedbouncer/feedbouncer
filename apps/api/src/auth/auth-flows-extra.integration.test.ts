import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import {
  PASSWORD,
  WEB,
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

describe('emailed links', () => {
  it('the emailed reset link is the web reset page carrying the token, and that token resets the password', async () => {
    await signUpAndVerify(api, 'rstlink@x.test');
    await api.req('POST', '/api/auth/request-password-reset', {
      body: { email: 'rstlink@x.test' },
    });
    await tick();
    const link = new URL(extractFirstUrl(api.mailer.lastTo('rstlink@x.test')!.text)!);
    expect(link.origin).toBe(WEB);
    expect(link.pathname).toBe('/reset-password');
    expect([...link.searchParams.keys()]).toEqual(['token']);
    const token = link.searchParams.get('token')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    const r = await api.req('POST', '/api/auth/reset-password', {
      body: { token, newPassword: 'reset through the emailed link 7' },
    });
    expect(r.status).toBe(200);
    await login(api, 'rstlink@x.test', 'reset through the emailed link 7');
  });

  it('the emailed verification link is a web-origin URL the proxy serves', async () => {
    const r = await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'vlink@x.test', password: PASSWORD, name: 'V' },
    });
    expect(r.status).toBe(202);
    await tick();
    const link = new URL(extractFirstUrl(api.mailer.lastTo('vlink@x.test')!.text)!);
    expect(link.origin).toBe(WEB);
    expect(link.pathname).toBe('/api/auth/verify-email');
    const v = await api.req('GET', `${link.pathname}${link.search}`);
    expect(v.status).toBe(302);
    expect(v.headers.location).toBe('/verified');
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

  it.each([
    ['POST /sign-in/email', { email: 'upl@x.test', password: 'a secret password 1' }, {}],
    ['POST /sign-out', {}, {}],
    ['POST /request-password-reset', { email: 'upl@x.test' }, {}],
    ['POST /reset-password', { token: 'tok-SECRET-1', newPassword: 'a secret password 2' }, {}],
    ['GET /verify-email', undefined, { query: '?token=tok-SECRET-2' }],
  ])('logs one redacted line when Better Auth fails on %s', async (route, body, opts) => {
    const spy = vi
      .spyOn(api.app.get<Auth>(AUTH), 'handler')
      .mockResolvedValueOnce(new Response('{"secret":"x"}', { status: 502 }));
    const before = api.logLines.length;
    try {
      const [method, path] = route.split(' ') as [string, string];
      const q = (opts as { query?: string }).query ?? '';
      await api.req(method, `/api/auth${path}${q}`, { body });
    } finally {
      spy.mockRestore();
    }
    const lines = api.logLines.slice(before).filter((l) => l.includes('auth upstream failed'));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ level: 'error', route, status: 502 });
    expect(lines[0]).not.toMatch(/SECRET|secret password|upl@x\.test|"secret"/);
  });

  it.each(['POST /change-password', 'POST /delete-user'])(
    'logs one redacted line when Better Auth fails on %s',
    async (route) => {
      const u = await signUpAndVerify(api, `uplc-${route.length}@x.test`);
      const cookie = await login(api, u.email);
      const spy = vi
        .spyOn(api.app.get<Auth>(AUTH), 'handler')
        .mockResolvedValueOnce(new Response('{}', { status: 500 }));
      const before = api.logLines.length;
      try {
        const r = await api.req('POST', `/api/auth${route.slice(5)}`, {
          cookie,
          body: { currentPassword: PASSWORD, password: PASSWORD, newPassword: 'x SECRET y z 12' },
        });
        expect(r.status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      const lines = api.logLines.slice(before).filter((l) => l.includes('auth upstream failed'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ route, status: 500 });
      expect(lines[0]).not.toMatch(/SECRET|uplc/);
    },
  );
});

describe('requests refused before the password check', () => {
  it('never spend the account login budget', async () => {
    const u = await signUpAndVerify(api, 'budget@x.test');
    const cookie = await login(api, u.email);
    const refused = [
      ['/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' }, 422],
      [
        '/api/auth/change-password',
        { currentPassword: PASSWORD, newPassword: 'aaaaaaaaaaaa' },
        422,
      ],
      ['/api/auth/change-password', { currentPassword: PASSWORD }, 400],
      ['/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 7 }, 400],
      ['/api/auth/delete-user', { password: '' }, 401],
      ['/api/auth/delete-user', {}, 401],
    ] as const;
    // More than the 5 attempts an account gets per window.
    for (const [path, body, status] of [...refused, ...refused]) {
      const r = await api.req('POST', path, { cookie, body });
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(status);
    }
    const r = await api.req('POST', '/api/auth/sign-in/email', {
      body: { email: u.email, password: PASSWORD },
    });
    expect(r.status).toBe(200);
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
