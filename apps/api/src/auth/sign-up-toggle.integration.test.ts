import { afterEach, describe, expect, it } from 'vitest';
import { newInvitationToken } from '../invitations/token.js';
import {
  login,
  PASSWORD,
  signUpAndVerify,
  startTestApi,
  type TestApi,
} from '../testing/harness.js';
import { AUTH } from '../tokens.js';
import { runApprovedSignUp, type Auth } from './auth.js';

const tick = () => new Promise((r) => setTimeout(r, 50)); // emails are fire-and-forget
const DISABLED = {
  error: { code: 'signup_disabled', message: 'Sign-up is disabled on this deployment.' },
};

let api: TestApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const signUp = (email: string, extra: Record<string, unknown> = {}, password = PASSWORD) =>
  api!.req('POST', '/api/v1/auth/sign-up', { body: { email, password, name: 'Pat', ...extra } });
const userCount = async (email: string) =>
  (await api!.pool.query('SELECT 1 FROM app_user WHERE email = $1', [email])).rowCount;

async function withSignupOn<T>(fn: () => Promise<T>): Promise<T> {
  const env = api!.deps.env as { signupEnabled: boolean };
  env.signupEnabled = true;
  try {
    return await fn();
  } finally {
    env.signupEnabled = false;
  }
}

async function invite(
  email: string,
  state: 'pending' | 'expired' | 'revoked' = 'pending',
  orgId?: string,
): Promise<{ token: string; orgId: string }> {
  const org =
    orgId ??
    (
      await api!.pool.query<{ id: string }>(
        `INSERT INTO organization (name) VALUES ('Inv') RETURNING id`,
      )
    ).rows[0]!.id;
  const { token, hash } = newInvitationToken();
  await api!.pool.query(
    `INSERT INTO invitation (organization_id, email, role, token_hash, status, expires_at, revoked_at)
     VALUES ($1, $2, 'member', $3, $4, now() + $5::interval, $6)`,
    [
      org,
      email,
      hash,
      state === 'revoked' ? 'revoked' : 'pending',
      state === 'expired' ? '-1 day' : '7 days',
      state === 'revoked' ? new Date() : null,
    ],
  );
  return { token, orgId: org };
}

describe('sign-up toggle', () => {
  it('enabled (default): sign-up returns 202 and creates the user', async () => {
    api = await startTestApi();
    const r = await signUp('open@example.com');
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: 'verification_sent' });
    expect(await userCount('open@example.com')).toBe(1);
  });

  it('enabled: GET /api/v1/auth/sign-up returns { enabled: true } with no-store', async () => {
    api = await startTestApi();
    const r = await api.req('GET', '/api/v1/auth/sign-up');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: true });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('disabled: GET returns { enabled: false } without a session', async () => {
    api = await startTestApi({ signupEnabled: false });
    const r = await api.req('GET', '/api/v1/auth/sign-up');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false });
  });

  it('disabled: direct POST returns 403 signup_disabled and creates no user', async () => {
    api = await startTestApi({ signupEnabled: false });
    const r = await signUp('nobody@example.com');
    expect(r.status).toBe(403);
    expect(r.body).toEqual(DISABLED);
    expect(await userCount('nobody@example.com')).toBe(0);
  });

  it('disabled: registered and unregistered emails get identical 403 and no mail', async () => {
    api = await startTestApi({ signupEnabled: false });
    await withSignupOn(() => signUpAndVerify(api!, 'known@example.com'));
    api.mailer.clear();
    const known = await signUp('known@example.com');
    const unknown = await signUp('unknown@example.com');
    await tick();
    expect(known.status).toBe(403);
    expect(known.body).toEqual(unknown.body);
    expect(unknown.body).toEqual(DISABLED);
    expect(api.mailer.sent).toHaveLength(0);
  });

  it('disabled: weak password still gets 403, not a password error', async () => {
    api = await startTestApi({ signupEnabled: false });
    const r = await signUp('weak@example.com', {}, 'short');
    expect(r.status).toBe(403);
    expect(r.body).toEqual(DISABLED);
  });

  it('disabled: invitation token must match a pending invitation for the same email', async () => {
    api = await startTestApi({ signupEnabled: false });
    const good = await invite('invited@example.com');
    const other = await invite('other@example.com');
    const expired = await invite('late@example.com', 'expired');
    const revoked = await invite('gone@example.com', 'revoked');

    const ok = await signUp(' Invited@Example.com ', { invitationToken: good.token });
    expect(ok.status).toBe(202);
    expect(await userCount('invited@example.com')).toBe(1);

    const cases: [string, Record<string, unknown>][] = [
      ['stolen@example.com', { invitationToken: other.token }],
      ['late@example.com', { invitationToken: expired.token }],
      ['gone@example.com', { invitationToken: revoked.token }],
      ['x@example.com', { invitationToken: 'x' }],
      ['y@example.com', {}],
    ];
    for (const [email, extra] of cases) {
      const r = await signUp(email, extra);
      expect(r.status, email).toBe(403);
      expect(r.body).toEqual(DISABLED);
      expect(await userCount(email)).toBe(0);
    }
  });

  it('disabled: rejection logs auth.signup_rejected_disabled at info without personal data', async () => {
    api = await startTestApi({ signupEnabled: false });
    const token = newInvitationToken().token;
    await signUp('private@example.com', { invitationToken: token });
    const line = api.logLines.find((l) => l.includes('auth.signup_rejected_disabled'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ level: 'info', invitationPresented: true });
    for (const secret of ['private@example.com', 'Pat', token, PASSWORD]) {
      expect(line).not.toContain(secret);
    }
  });

  it('disabled: backstop refuses direct Better Auth user creation', async () => {
    api = await startTestApi({ signupEnabled: false });
    const auth = api.app.get<Auth>(AUTH);
    const body = { email: 'direct@example.com', password: PASSWORD, name: 'Direct' };
    // Better Auth answers a refused (403) creation with a placeholder user, never a row.
    await auth.api.signUpEmail({ body });
    expect(await userCount('direct@example.com')).toBe(0);
    expect(api.logLines.some((l) => l.includes('auth.signup_blocked_by_backstop'))).toBe(true);

    await runApprovedSignUp(() => auth.api.signUpEmail({ body }));
    expect(await userCount('direct@example.com')).toBe(1);
  });

  it('disabled: existing user can sign in, reset password, use an API key, create an org and accept an invitation', async () => {
    api = await startTestApi({ signupEnabled: false });
    const user = await withSignupOn(() => signUpAndVerify(api!, 'member@example.com'));
    const second = await withSignupOn(() => signUpAndVerify(api!, 'second@example.com'));
    api.mailer.clear();

    const cookie = await login(api, user.email);
    const reset = await api.req('POST', '/api/auth/request-password-reset', {
      body: { email: user.email, redirectTo: '/reset-password' },
    });
    expect(reset.status).toBe(200);
    await tick();
    expect(api.mailer.lastTo(user.email)).toBeDefined();

    const org = await api.req('POST', '/api/v1/orgs', {
      cookie,
      body: { name: 'Acme', brandName: 'Acme' },
    });
    expect(org.status).toBe(201);
    const orgId = org.body.organization.id as string;

    const key = await api.req('POST', `/api/v1/orgs/${orgId}/api-keys`, {
      cookie,
      body: { name: 'k', scope: 'read' },
    });
    expect(key.status).toBe(201);
    const viaKey = await api.raw('GET', '/v1/key', {
      headers: { authorization: `Bearer ${key.body.token}` },
    });
    expect(viaKey.status).toBe(200);

    const { token } = await invite(second.email, 'pending', orgId);
    const accepted = await api.req('POST', '/api/v1/invitations/accept', {
      cookie: await login(api, second.email),
      body: { token },
    });
    expect(accepted.status).toBe(200);
  });

  it.each([true, false])(
    'Better Auth /api/auth/sign-up/email stays 404 (signupEnabled=%s)',
    async (enabled) => {
      api = await startTestApi({ signupEnabled: enabled });
      const r = await api.req('POST', '/api/auth/sign-up/email', {
        body: { email: 'ba@example.com', password: PASSWORD, name: 'BA' },
      });
      expect(r.status).toBe(404);
      expect(await userCount('ba@example.com')).toBe(0);
    },
  );
});
