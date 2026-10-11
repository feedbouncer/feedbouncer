import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFirstUrl } from '@feedbouncer/mailer/testing';
import { startTestApi, type TestApi, type TestResponse } from '../testing/harness.js';
import { digestSessionToken } from '../auth/session-token-digest.js';
import { hashInvitationToken } from '../invitations/token.js';

const SIGN_UP_SUBJECT = 'Confirm your email for FeedBouncer';
const RESET_SUBJECT = 'Reset your FeedBouncer password';
const PASSWORD = 'unique sentinel passphrase 9137';
const NEW_PASSWORD = 'another sentinel passphrase 5521';

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

/**
 * Emails are fire-and-forget: poll the in-memory mailer until the nth message to
 * `to` whose subject matches has arrived, and return the link in that message.
 */
async function linkFrom(to: string, subject: RegExp | string, nth = 1): Promise<URL> {
  const matches = () =>
    api.mailer.sent.filter(
      (m) =>
        m.to.toLowerCase() === to &&
        (typeof subject === 'string' ? m.subject === subject : subject.test(m.subject)),
    );
  const deadline = Date.now() + 5000;
  while (matches().length < nth) {
    if (Date.now() > deadline)
      throw new Error(`mail ${nth} to ${to} (${String(subject)}) never arrived`);
    await new Promise((r) => setTimeout(r, 10));
  }
  const url = extractFirstUrl(matches()[nth - 1]!.text);
  if (!url) throw new Error(`no link in mail to ${to}`);
  return new URL(url);
}

/** A needle shorter than this would match by accident and prove nothing. */
function secret(name: string, value: string | null | undefined): string {
  expect(typeof value, `${name} type`).toBe('string');
  expect(value!.length, `${name} length`).toBeGreaterThanOrEqual(16);
  return value!;
}

const queryToken = (u: URL) => u.searchParams.get('token');

describe('no secrets in responses or logs', () => {
  it('keeps passwords, hashes, session, invitation, reset and verification tokens out of both', async () => {
    const seen: TestResponse[] = [];
    const call = async (...args: Parameters<TestApi['req']>) => {
      const r = await api.req(...args);
      seen.push(r);
      return r;
    };

    seen.push(
      await api.req('POST', '/api/v1/auth/sign-up', {
        body: { email: 'sec@x.test', password: PASSWORD, name: 'Sec' },
      }),
    );
    const verifyUrl = await linkFrom('sec@x.test', SIGN_UP_SUBJECT);
    const verificationToken = secret('verification token', queryToken(verifyUrl));
    await call('GET', verifyUrl.pathname + verifyUrl.search);

    const signIn = await call('POST', '/api/auth/sign-in/email', {
      body: { email: 'sec@x.test', password: PASSWORD },
    });
    const cookie = signIn.cookie!;
    const sessionToken = secret(
      'session token',
      decodeURIComponent(cookie.split('=')[1]!.split('.')[0]!),
    );
    const cookieValue = secret('session cookie value', cookie.split('=')[1]);

    const org = await call('POST', '/api/v1/orgs', {
      cookie,
      body: { name: 'Sec Org', brandName: 'Sec Brand' },
    });
    const orgId = org.body.organization.id as string;
    await call('POST', `/api/v1/orgs/${orgId}/invitations`, {
      cookie,
      body: { email: 'sec2@x.test', role: 'member' },
    });
    const inviteUrl = await linkFrom('sec2@x.test', /^Join .* on FeedBouncer$/);
    const inviteToken = secret('invitation token', queryToken(inviteUrl));

    await call('GET', '/api/v1/me', { cookie });
    await call('GET', '/api/v1/orgs', { cookie });
    await call('GET', `/api/v1/orgs/${orgId}`, { cookie });
    await call('GET', `/api/v1/orgs/${orgId}/members`, { cookie });
    await call('GET', `/api/v1/orgs/${orgId}/invitations`, { cookie });
    await call('POST', '/api/v1/invitations/lookup', { cookie, body: { token: inviteToken } });
    await call('POST', '/api/auth/sign-in/email', {
      body: { email: 'sec@x.test', password: 'wrong wrong wrong 1' },
    });

    // Password reset: the token is only in the email and in the reset request.
    await call('POST', '/api/auth/request-password-reset', { body: { email: 'sec@x.test' } });
    const resetUrl = await linkFrom('sec@x.test', RESET_SUBJECT);
    // The link is the web reset page with the token in its query string.
    const resetToken = secret('reset token', queryToken(resetUrl));
    const reset = await call('POST', '/api/auth/reset-password', {
      body: { token: resetToken, newPassword: NEW_PASSWORD },
    });
    expect(reset.status).toBe(200);

    const { rows } = await api.pool.query(
      `SELECT a.password_hash FROM auth_account a JOIN app_user u ON u.id = a.user_id
       WHERE u.email = 'sec@x.test'`,
    );
    const passwordHash = secret('password hash', rows[0]?.password_hash as string | undefined);
    const inviteHash = hashInvitationToken(inviteToken)!;
    expect(inviteHash.length).toBeGreaterThan(0);
    const secrets = {
      password: PASSWORD,
      newPassword: NEW_PASSWORD,
      passwordHash,
      sessionToken,
      sessionDigest: digestSessionToken(sessionToken),
      cookie: cookieValue,
      inviteToken,
      inviteHashHex: inviteHash.toString('hex'),
      inviteHashBase64: inviteHash.toString('base64'),
      inviteHashBase64Url: inviteHash.toString('base64url'),
      resetToken,
      verificationToken,
      authSecret: api.deps.env.authSecret,
      databaseUrl: String(api.deps.env.databaseUrl),
      redisUrl: api.deps.env.redisUrl.href,
      smtpUrl: api.deps.env.smtpUrl.href,
      authSecretDigest: createHash('sha256').update(api.deps.env.authSecret).digest('hex'),
    };

    // Set-Cookie is the one place a session token legitimately travels, as the cookie itself.
    const bodiesAndHeaders = seen.map((r) => {
      const headers = { ...r.headers };
      delete headers['set-cookie'];
      return JSON.stringify({ body: r.body, headers });
    });
    const haystack = [...bodiesAndHeaders, ...api.logLines].join('\n');
    expect(api.logLines.length).toBeGreaterThan(0);
    for (const [name, needle] of Object.entries(secrets)) {
      secret(name, needle);
      expect(haystack.includes(needle), `${name} leaked`).toBe(false);
    }
    expect(api.logLines.join('\n')).not.toMatch(/token=/);
    expect(api.logLines.join('\n')).not.toContain('sec@x.test');
  });
});
