// Pins every Better Auth behavior the API relies on, against our hand-written
// schema. Calls auth.api.* directly (no HTTP proxy).
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import { startTestApi, type TestApi } from '../testing/harness.js';
import { AUTH } from '../tokens.js';
import { createAuth, UserDeletionBlockedError } from './auth.js';
import { createAuthEmails } from './emails.js';
import { findUserById, findUserIdByEmail } from './users.repo.js';

let api: TestApi;
let auth: ReturnType<typeof createAuth>;
let beforeDeleteUser: (userId: string) => Promise<void> = async () => {};
beforeAll(async () => {
  api = await startTestApi();
  auth = createAuth(api.deps, createAuthEmails(api.mailer, api.deps.log, 'http://localhost:3000'), {
    beforeDeleteUser: (userId) => beforeDeleteUser(userId),
  });
});
afterAll(() => api.close());
const flush = () => new Promise((r) => setTimeout(r, 20)); // emails are fire-and-forget
const PW = 'correct horse battery staple 42';
const SESSION_COOKIE = 'fb.session_token';
const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');

async function signUp(email: string) {
  await auth.api.signUpEmail({ body: { email, password: PW, name: 'Ana' } });
  await flush();
}

/** Signs in and returns the issued token and the Cookie header that carries it. */
async function signIn(email: string) {
  const res = await auth.api.signInEmail({
    body: { email, password: PW },
    returnHeaders: true,
  });
  return { token: res.response.token, cookie: sessionCookie(res.headers)! };
}

/** `fb.session_token=<value>` from a response's Set-Cookie, or null. */
function sessionCookie(headers: Headers): string | null {
  const c = headers.getSetCookie().find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  return c ? c.split(';')[0]! : null;
}

async function resetLinkToken(email: string) {
  await auth.api.requestPasswordReset({
    body: { email, redirectTo: 'http://localhost:3000/reset-password' },
  });
  await flush();
  const link = extractFirstUrl(api.mailer.lastTo(email)!.text)!;
  return new URL(link).searchParams.get('token')!;
}

const getSession = (cookie: string) => auth.api.getSession({ headers: new Headers({ cookie }) });

describe('Better Auth on our schema', () => {
  it('creates app_user with a uuid id, display_name and email_verified=false', async () => {
    await signUp('c1@x.test');
    const { rows } = await api.pool.query(
      "SELECT id, display_name, email_verified FROM app_user WHERE email = 'c1@x.test'",
    );
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].display_name).toBe('Ana');
    expect(rows[0].email_verified).toBe(false);
  });

  it('stores a salted slow hash, never the password', async () => {
    await signUp('c2@x.test');
    await expect(signUp('c3@x.test')).resolves.toBeUndefined();
    const { rows } = await api.pool.query(
      "SELECT a.password_hash FROM auth_account a JOIN app_user u ON u.id = a.user_id WHERE u.email IN ('c2@x.test','c3@x.test')",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].password_hash).not.toBe(rows[1].password_hash); // salted
    for (const r of rows) {
      expect(r.password_hash).not.toContain(PW);
      expect(r.password_hash.length).toBeGreaterThan(60);
    }
  });

  it('sends a verification email on sign-up whose link verifies the address', async () => {
    await signUp('c4@x.test');
    const url = new URL(extractFirstUrl(api.mailer.lastTo('c4@x.test')!.text)!);
    expect(url.origin).toBe('http://localhost:3000');
    expect(url.pathname).toBe('/api/auth/verify-email');
    await auth.api.verifyEmail({ query: { token: url.searchParams.get('token')! } });
    const { rows } = await api.pool.query(
      "SELECT email_verified FROM app_user WHERE email = 'c4@x.test'",
    );
    expect(rows[0].email_verified).toBe(true);
  });

  it('reset tokens are single-use and revoke all sessions', async () => {
    await signUp('c5@x.test');
    await signIn('c5@x.test');
    const token = await resetLinkToken('c5@x.test');
    await auth.api.resetPassword({ body: { token, newPassword: 'another long passphrase 77' } });
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: 'third long passphrase 99' } }),
    ).rejects.toBeTruthy();
    const { rows } = await api.pool.query(
      "SELECT count(*)::int AS n FROM auth_session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'c5@x.test'",
    );
    expect(rows[0].n).toBe(0);
  });

  it('reset tokens are stored hashed, never as issued', async () => {
    await signUp('c9@x.test');
    const token = await resetLinkToken('c9@x.test');
    const { rows } = await api.pool.query<{ identifier: string; value: string }>(
      'SELECT identifier, value FROM auth_verification',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.identifier).not.toContain(token);
      expect(r.value).not.toContain(token);
    }
    expect(rows.map((r) => r.identifier)).toContain(sha256(`reset-password:${token}`));
    // The emailed link still works, once.
    await auth.api.resetPassword({ body: { token, newPassword: 'another long passphrase 77' } });
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: 'third long passphrase 99' } }),
    ).rejects.toBeTruthy();
  });

  it('expired reset tokens are refused', async () => {
    await signUp('c6@x.test');
    const token = await resetLinkToken('c6@x.test');
    await api.pool.query("UPDATE auth_verification SET expires_at = now() - interval '1 second'");
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: 'another long passphrase 77' } }),
    ).rejects.toBeTruthy();
  });

  it('requestPasswordReset for an unknown email succeeds silently and sends nothing', async () => {
    const before = api.mailer.sent.length;
    await auth.api.requestPasswordReset({
      body: { email: 'nobody@x.test', redirectTo: 'http://localhost:3000/reset-password' },
    });
    await flush();
    expect(api.mailer.sent.length).toBe(before);
  });

  it('session rows expire in ~7 days', async () => {
    await signUp('c7@x.test');
    await signIn('c7@x.test');
    const { rows } = await api.pool.query(
      "SELECT extract(epoch FROM s.expires_at - now())::int AS secs FROM auth_session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'c7@x.test'",
    );
    expect(rows[0].secs).toBeGreaterThan(604800 - 120);
    expect(rows[0].secs).toBeLessThanOrEqual(604800);
  });

  describe('session tokens are stored as SHA-256 digests', () => {
    async function storedToken(email: string) {
      const { rows } = await api.pool.query<{ token: string }>(
        'SELECT s.token FROM auth_session s JOIN app_user u ON u.id = s.user_id WHERE u.email = $1',
        [email],
      );
      expect(rows).toHaveLength(1);
      return rows[0]!.token;
    }

    it('stores sha256(issued token), not the token', async () => {
      await signUp('c8@x.test');
      const { token } = await signIn('c8@x.test');
      const stored = await storedToken('c8@x.test');
      expect(stored).not.toBe(token);
      expect(stored).toBe(sha256(token));
    });

    it('the issued cookie authenticates', async () => {
      await signUp('c10@x.test');
      const { cookie, token } = await signIn('c10@x.test');
      const s = await getSession(cookie);
      expect(s?.user.email).toBe('c10@x.test');
      expect(s?.session.token).toBe(token);
    });

    it('a session refresh re-issues the raw token and keeps the digest at rest', async () => {
      await signUp('c11@x.test');
      const { cookie, token } = await signIn('c11@x.test');
      // Age the session past updateAge (1 day) so the next read refreshes it.
      await api.pool.query(
        "UPDATE auth_session SET expires_at = now() + interval '5 days' WHERE token = $1",
        [sha256(token)],
      );
      const res = await auth.api.getSession({
        headers: new Headers({ cookie }),
        returnHeaders: true,
      });
      expect(res.response?.user.email).toBe('c11@x.test');
      expect(sessionCookie(res.headers)).toBe(cookie);
      const { rows } = await api.pool.query(
        'SELECT extract(epoch FROM expires_at - now())::int AS secs, token FROM auth_session WHERE token = $1',
        [sha256(token)],
      );
      expect(rows[0].secs).toBeGreaterThan(604800 - 120);
      expect(await storedToken('c11@x.test')).toBe(sha256(token));
      expect((await getSession(cookie))?.user.email).toBe('c11@x.test');
    });

    it('the stored digest does not authenticate, even correctly signed', async () => {
      await signUp('c12@x.test');
      const { token } = await signIn('c12@x.test');
      const stored = await storedToken('c12@x.test');
      const secret = api.deps.env.authSecret;
      const forge = async (v: string) =>
        `${SESSION_COOKIE}=${encodeURIComponent(`${v}.${await makeSignature(v, secret)}`)}`;
      // Control: signing the issued token this way does authenticate.
      expect((await getSession(await forge(token)))?.user.email).toBe('c12@x.test');
      expect(await getSession(await forge(stored))).toBeNull();
    });

    it('sign-out deletes the session row', async () => {
      await signUp('c13@x.test');
      const { cookie } = await signIn('c13@x.test');
      await auth.api.signOut({ headers: new Headers({ cookie }) });
      const { rows } = await api.pool.query(
        "SELECT count(*)::int AS n FROM auth_session s JOIN app_user u ON u.id = s.user_id WHERE u.email = 'c13@x.test'",
      );
      expect(rows[0].n).toBe(0);
      expect(await getSession(cookie)).toBeNull();
    });
  });

  describe('account deletion hook', () => {
    const userCount = async (email: string) =>
      (await api.pool.query('SELECT 1 FROM app_user WHERE email = $1', [email])).rowCount;
    const attemptDelete = async (email: string) => {
      const { cookie } = await signIn(email);
      return auth.api.deleteUser({ headers: new Headers({ cookie }), body: { password: PW } });
    };

    it('a typed denial is reported as 409 sole_owner and keeps the user', async () => {
      await signUp('d1@x.test');
      beforeDeleteUser = async () => {
        throw new UserDeletionBlockedError('sole owner');
      };
      await expect(attemptDelete('d1@x.test')).rejects.toMatchObject({
        statusCode: 409,
        body: { message: 'sole_owner' },
      });
      expect(await userCount('d1@x.test')).toBe(1);
    });

    it('any other failure is not reported as sole_owner and keeps the user', async () => {
      await signUp('d2@x.test');
      beforeDeleteUser = async () => {
        throw new Error('connection reset');
      };
      const err = await attemptDelete('d2@x.test').then(
        () => null,
        (e: unknown) => e as { statusCode?: number; body?: { message?: string } },
      );
      expect(err).not.toBeNull();
      expect(err?.body?.message).not.toBe('sole_owner');
      expect(err?.statusCode ?? 500).toBeGreaterThanOrEqual(500);
      expect(await userCount('d2@x.test')).toBe(1);
    });

    it('deletes the user when the hook allows it', async () => {
      await signUp('d3@x.test');
      beforeDeleteUser = async () => {};
      await attemptDelete('d3@x.test');
      expect(await userCount('d3@x.test')).toBe(0);
    });
  });

  it('never logs passwords or tokens', async () => {
    await signUp('c16@x.test');
    const { token } = await signIn('c16@x.test');
    const resetToken = await resetLinkToken('c16@x.test');
    await auth.api.resetPassword({ body: { token: resetToken, newPassword: PW } });
    await auth.api
      .signInEmail({ body: { email: 'c16@x.test', password: 'wrong password 1234' } })
      .catch(() => {});
    const all = api.logLines.join('\n');
    for (const secret of [PW, token, resetToken, 'wrong password 1234'])
      expect(all).not.toContain(secret);
  });

  it('the app module provides AUTH, wired to the app mailer', async () => {
    const appAuth = api.app.get<ReturnType<typeof createAuth>>(AUTH);
    await appAuth.api.signUpEmail({ body: { email: 'c15@x.test', password: PW, name: 'Ana' } });
    await flush();
    expect(api.mailer.lastTo('c15@x.test')?.subject).toBe('Confirm your email for FeedBouncer');
  });

  it('users.repo reads the mapped columns', async () => {
    await signUp('c14@x.test');
    const id = await findUserIdByEmail(api.pool, 'c14@x.test');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await findUserById(api.pool, id!)).toEqual({
      id,
      email: 'c14@x.test',
      name: 'Ana',
      emailVerified: false,
    });
    expect(await findUserIdByEmail(api.pool, 'nobody@x.test')).toBeNull();
    expect(await findUserById(api.pool, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
