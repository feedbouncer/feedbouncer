import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PASSWORD,
  login,
  orgWithRoles,
  startTestApi,
  verifiedUser,
  type TestApi,
} from '../testing/harness.js';
import { ACCOUNT_DELETION } from '../tokens.js';
import type { AuthHooks } from './auth.js';

let api: TestApi;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

const del = (cookie: string, password = PASSWORD) =>
  api.req('POST', '/api/auth/delete-user', { cookie, body: { password } });
const rawDel = (cookie: string, body: unknown) =>
  api.req('POST', '/api/auth/delete-user', { cookie, body });
// One user for the rejected-password cases: nothing is ever deleted or changed,
// and sign-ups are rate limited per address.
let shared: ReturnType<typeof verifiedUser> | undefined;
const sharedUser = () => (shared ??= verifiedUser(api, 'del-empty'));
const userRows = async (userId: string) =>
  (await api.pool.query('SELECT 1 FROM app_user WHERE id = $1', [userId])).rowCount;

describe('account deletion', () => {
  it('a sole owner cannot delete their account', async () => {
    const { owner, orgId } = await orgWithRoles(api, 'del');
    const r = await del(owner.cookie);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('sole_owner');
    expect(await userRows(owner.userId)).toBe(1);
    expect((await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie: owner.cookie })).status).toBe(
      200,
    );
  });

  it('the only member of their own organization is blocked too', async () => {
    const u = await verifiedUser(api, 'del-solo');
    const created = await api.req('POST', '/api/v1/orgs', {
      cookie: u.cookie,
      body: { name: 'Solo Org', brandName: 'Solo Brand' },
    });
    expect(created.status).toBe(201);
    const r = await del(u.cookie);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('sole_owner');
    expect(await userRows(u.userId)).toBe(1);
  });

  it('a co-owner and a member can delete their accounts; audit rows survive with actor NULL', async () => {
    const { orgId, owner, member } = await orgWithRoles(api, 'del2');
    await api.pool.query(
      "UPDATE membership SET role = 'owner' WHERE organization_id = $1 AND user_id = $2",
      [orgId, member.userId],
    );
    const audit = 'SELECT 1 FROM audit_event WHERE organization_id = $1 AND actor_user_id IS NULL';
    expect((await api.pool.query(audit, [orgId])).rowCount).toBe(0);
    expect((await del(owner.cookie)).status).toBe(200);
    expect(await userRows(owner.userId)).toBe(0);
    expect((await api.req('GET', '/api/v1/me', { cookie: owner.cookie })).status).toBe(401);
    expect((await api.pool.query(audit, [orgId])).rowCount).toBeGreaterThan(0);
    // The remaining owner is now the sole owner.
    expect((await del(member.cookie)).status).toBe(409);
  });

  it('a non-owner member can delete their account', async () => {
    const { owner, member, orgId } = await orgWithRoles(api, 'del4');
    expect((await del(member.cookie)).status).toBe(200);
    expect(await userRows(member.userId)).toBe(0);
    expect((await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie: owner.cookie })).status).toBe(
      200,
    );
  });

  it('wrong password is 401 and deletes nothing', async () => {
    const u = await verifiedUser(api, 'del3');
    expect((await del(u.cookie, 'nope nope nope 1')).status).toBe(401);
    expect(await userRows(u.userId)).toBe(1);
  });

  it.each([
    ['empty string', { password: '' }],
    ['whitespace only', { password: '   ' }],
    ['null', { password: null }],
    ['number', { password: 0 }],
    ['array', { password: [''] }],
    ['missing', {}],
  ])('a %s password deletes nothing and is 401', async (_name, body) => {
    const u = await sharedUser();
    // A fresh session is younger than freshAge: only the password check protects the account.
    const r = await rawDel(u.cookie, body);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('invalid_credentials');
    expect(await userRows(u.userId)).toBe(1);
    expect((await api.req('GET', '/api/v1/me', { cookie: u.cookie })).status).toBe(200);
  });

  it.each([
    ['empty string', { currentPassword: '', newPassword: 'another long passphrase 77' }],
    ['non-string', { currentPassword: 0, newPassword: 'another long passphrase 77' }],
    ['missing', { newPassword: 'another long passphrase 77' }],
  ])('change-password with a %s current password changes nothing', async (_name, body) => {
    const u = await sharedUser();
    const r = await api.req('POST', '/api/auth/change-password', { cookie: u.cookie, body });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('invalid_credentials');
    await expect(login(api, u.email)).resolves.toBeTruthy();
    await expect(login(api, u.email, 'another long passphrase 77')).rejects.toThrow();
  });

  it('a last-owner race caught by the database is 409 and leaves the user able to sign in', async () => {
    const { owner } = await orgWithRoles(api, 'del5');
    const hooks = api.app.get<AuthHooks>(ACCOUNT_DELETION);
    const original = hooks.beforeDeleteUser;
    hooks.beforeDeleteUser = async () => {}; // the check passed before a co-owner left
    try {
      const r = await del(owner.cookie);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('sole_owner');
    } finally {
      hooks.beforeDeleteUser = original;
    }
    expect(await userRows(owner.userId)).toBe(1);
    await expect(login(api, owner.email)).resolves.toBeTruthy();
    expect((await api.req('GET', '/api/v1/me', { cookie: owner.cookie })).status).toBe(200);
  });
});
