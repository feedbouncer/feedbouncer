import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgApiKeys } from '@feedbouncer/public-api';
import {
  PASSWORD,
  login,
  orgWithRoles,
  startTestApi,
  verifiedUser,
  type OrgFixture,
  type TestApi,
  type TestUser,
} from '../testing/harness.js';

let api: TestApi;
let keys: PgApiKeys;
let org: OrgFixture;
beforeAll(async () => {
  api = await startTestApi({ trustProxyHops: 1 });
  keys = new PgApiKeys(api.pool);
  org = await orgWithRoles(api, 'ustat');
});
afterAll(() => api.close());

let seq = 0;
const setUserStatus = (id: string, s: string) =>
  api.pool.query('UPDATE app_user SET status = $2 WHERE id = $1', [id, s]);
const setOrgStatus = (id: string, s: string) =>
  api.pool.query('UPDATE organization SET status = $2 WHERE id = $1', [id, s]);
const sessions = async (userId: string) =>
  (
    await api.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM auth_session WHERE user_id = $1',
      [userId],
    )
  ).rows[0]!.n;
const signIn = (email: string, password: string) =>
  api.req('POST', '/api/auth/sign-in/email', { body: { email, password } });
const me = (cookie: string) => api.req('GET', '/api/v1/me', { cookie });
const newKey = async (creator: TestUser) => {
  const { key, token } = await keys.create(org.orgId, creator.userId, {
    name: `k${++seq}`,
    scope: 'read',
  });
  return { key, token: token.reveal() };
};
const list = (token: string) =>
  api.req('GET', '/v1/comments', {
    headers: { 'x-forwarded-for': `198.51.100.${++seq % 250}`, authorization: `Bearer ${token}` },
  });

describe('inactive users', () => {
  it('inactive user cannot sign in and gets the generic error', async () => {
    const u = await verifiedUser(api, 'ustat-signin');
    const wrong = await signIn(u.email, `${PASSWORD}x`);
    const before = await sessions(u.userId);
    await setUserStatus(u.userId, 'suspended');
    const r = await signIn(u.email, PASSWORD);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('invalid_credentials');
    expect(r.body).toEqual(wrong.body);
    expect(r.cookie).toBeNull();
    expect(await sessions(u.userId)).toBe(before);
    const line = api.logLines.find(
      (l) => l.includes('user.access_denied_inactive') && l.includes(u.userId),
    );
    expect(line).toContain('"via":"sign_in"');
  });

  it('open session stops working on the next request', async () => {
    const u = await verifiedUser(api, 'ustat-open');
    expect((await me(u.cookie)).status).toBe(200);
    await setUserStatus(u.userId, 'suspended');
    const r = await me(u.cookie);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthenticated');
  });

  it('a session row of an inactive user is refused by SessionGuard and change-password', async () => {
    const u = await verifiedUser(api, 'ustat-row');
    await setUserStatus(u.userId, 'suspended');
    expect(await sessions(u.userId)).toBeGreaterThan(0);
    expect((await me(u.cookie)).status).toBe(401);
    const r = await api.req('POST', '/api/auth/change-password', {
      cookie: u.cookie,
      body: { currentPassword: PASSWORD, newPassword: 'a brand new passphrase 77' },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthenticated');
    await setUserStatus(u.userId, 'active');
    expect((await signIn(u.email, PASSWORD)).status).toBe(200);
  });

  it('reactivated user can sign in again and keeps memberships', async () => {
    await setUserStatus(org.member.userId, 'suspended');
    expect((await signIn(org.member.email, PASSWORD)).status).toBe(401);
    await setUserStatus(org.member.userId, 'active');
    const cookie = await login(api, org.member.email);
    const r = await me(cookie);
    expect(r.status).toBe(200);
    expect(r.body.memberships).toContainEqual(
      expect.objectContaining({ organizationId: org.orgId, role: 'member' }),
    );
  });

  it('key created by an inactive user is 403 key_owner_inactive; wrong secret stays 401; reactivation restores it', async () => {
    const { token } = await newKey(org.admin);
    await setUserStatus(org.admin.userId, 'suspended');
    try {
      const r = await list(token);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({
        error: { code: 'key_owner_inactive', message: "This API key's creator is deactivated." },
      });
      const wrong = await list(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`);
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('unauthenticated');
    } finally {
      await setUserStatus(org.admin.userId, 'active');
    }
    expect((await list(token)).status).toBe(200);
  });

  it('org-owned key (creator NULL) keeps working', async () => {
    const { key, token } = await newKey(org.admin);
    await api.pool.query('UPDATE api_key SET created_by_user_id = NULL WHERE id = $1', [key.id]);
    expect((await list(token)).status).toBe(200);
  });

  it('inactive org still answers organization_suspended before the creator check', async () => {
    const { token } = await newKey(org.admin);
    await setUserStatus(org.admin.userId, 'suspended');
    await setOrgStatus(org.orgId, 'suspended');
    try {
      const r = await list(token);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('organization_suspended');
    } finally {
      await setOrgStatus(org.orgId, 'active');
      await setUserStatus(org.admin.userId, 'active');
    }
  });

  it('logs never contain the email or token', async () => {
    const u = await verifiedUser(api, 'ustat-logs');
    const { key, token } = await newKey(u);
    await setUserStatus(u.userId, 'suspended');
    await signIn(u.email, PASSWORD);
    await me(u.cookie);
    await list(token);
    const denied = api.logLines.filter((l) => l.includes('user.access_denied_inactive'));
    expect(denied.some((l) => l.includes(`"apiKeyId":"${key.id}"`))).toBe(true);
    const sessionToken = decodeURIComponent(u.cookie.split('=')[1]!.split('.')[0]!);
    for (const l of api.logLines) {
      expect(l).not.toContain(u.email);
      expect(l).not.toContain(token);
      expect(l).not.toContain(sessionToken);
    }
  });
});
