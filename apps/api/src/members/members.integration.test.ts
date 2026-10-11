import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

let api: TestApi;
// Sign-ups are rate limited per test file, so every organization reuses these users.
let shared: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
beforeAll(async () => {
  api = await startTestApi();
  const first = await orgWithRoles(api, 'mb');
  shared = { owner: first.owner, admin: first.admin, member: first.member };
});
afterAll(() => api.close());

const org = (label: string) => orgWithRoles(api, label, shared);
const role = (orgId: string, userId: string) =>
  api.pool
    .query('SELECT role FROM membership WHERE organization_id = $1 AND user_id = $2', [
      orgId,
      userId,
    ])
    .then((r) => r.rows[0]?.role ?? null);

describe('members list', () => {
  it('lists only the DTO fields, to every member, and 404s for outsiders', async () => {
    const { orgId, member } = await org('ml');
    const r = await api.req('GET', `/api/v1/orgs/${orgId}/members`, { cookie: member.cookie });
    expect(r.status).toBe(200);
    expect(r.body.members).toHaveLength(3);
    for (const m of r.body.members) {
      expect(Object.keys(m).sort()).toEqual(['email', 'joinedAt', 'name', 'role', 'userId']);
    }
    const outsider = await orgWithRoles(api, 'ml-out');
    const denied = await api.req('GET', `/api/v1/orgs/${orgId}/members`, {
      cookie: outsider.owner.cookie,
    });
    expect(denied.status).toBe(404);
  });
});

describe('role changes', () => {
  it('owner can change any role; admin only member<->admin', async () => {
    const { orgId, owner, admin, member } = await org('rc');
    const patch = (who: { cookie: string }, uid: string, r: string) =>
      api.req('PATCH', `/api/v1/orgs/${orgId}/members/${uid}`, {
        cookie: who.cookie,
        body: { role: r },
      });
    expect((await patch(admin, member.userId, 'admin')).status).toBe(200);
    expect((await patch(admin, member.userId, 'member')).status).toBe(200);
    expect((await patch(admin, member.userId, 'owner')).body.error.code).toBe('cannot_grant_owner');
    expect((await patch(admin, owner.userId, 'member')).body.error.code).toBe(
      'cannot_act_on_owner',
    );
    expect((await patch(member, admin.userId, 'member')).status).toBe(403);
    expect((await patch(owner, member.userId, 'owner')).status).toBe(200);
    expect(await role(orgId, member.userId)).toBe('owner');
  });

  it('the last owner cannot demote themselves', async () => {
    const { orgId, owner } = await org('lastd');
    const r = await api.req('PATCH', `/api/v1/orgs/${orgId}/members/${owner.userId}`, {
      cookie: owner.cookie,
      body: { role: 'admin' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('last_owner');
  });

  it('two owners demoting each other concurrently leaves exactly one owner', async () => {
    const { orgId, owner, member } = await org('race');
    await api.pool.query(
      "UPDATE membership SET role = 'owner' WHERE organization_id = $1 AND user_id = $2",
      [orgId, member.userId],
    );
    const [a, b] = await Promise.all([
      api.req('PATCH', `/api/v1/orgs/${orgId}/members/${member.userId}`, {
        cookie: owner.cookie,
        body: { role: 'member' },
      }),
      api.req('PATCH', `/api/v1/orgs/${orgId}/members/${owner.userId}`, {
        cookie: member.cookie,
        body: { role: 'member' },
      }),
    ]);
    // The loser gets 409 (last owner) or 403 (already demoted when it re-read its role).
    expect([409 + 200, 403 + 200]).toContain(a.status + b.status);
    const owners = await api.pool.query(
      "SELECT count(*)::int AS n FROM membership WHERE organization_id = $1 AND role = 'owner'",
      [orgId],
    );
    expect(owners.rows[0].n).toBe(1);
  });

  it('rejects unknown roles and non-member targets', async () => {
    const { orgId, owner } = await org('rc2');
    const url = `/api/v1/orgs/${orgId}/members`;
    const bad = await api.req('PATCH', `${url}/${owner.userId}`, {
      cookie: owner.cookie,
      body: { role: 'god' },
    });
    expect(bad.status).toBe(400);
    const missing = await api.req('PATCH', `${url}/${randomUUID()}`, {
      cookie: owner.cookie,
      body: { role: 'admin' },
    });
    expect(missing.status).toBe(404);
  });
});

describe('removal and leaving', () => {
  it('admin removes a member; the member loses access on the next request', async () => {
    const { orgId, admin, member } = await org('rm');
    expect((await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie: member.cookie })).status).toBe(
      200,
    );
    const del = await api.req('DELETE', `/api/v1/orgs/${orgId}/members/${member.userId}`, {
      cookie: admin.cookie,
    });
    expect(del.status).toBe(204);
    expect((await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie: member.cookie })).status).toBe(
      404,
    );
    const orgIds = (await api.req('GET', '/api/v1/me', { cookie: member.cookie })).body.memberships;
    expect(orgIds.some((m: { organizationId: string }) => m.organizationId === orgId)).toBe(false);
  });

  it('admin cannot remove an owner; member cannot remove anyone', async () => {
    const { orgId, owner, admin, member } = await org('rm2');
    const byAdmin = await api.req('DELETE', `/api/v1/orgs/${orgId}/members/${owner.userId}`, {
      cookie: admin.cookie,
    });
    expect(byAdmin.body.error.code).toBe('cannot_act_on_owner');
    const byMember = await api.req('DELETE', `/api/v1/orgs/${orgId}/members/${admin.userId}`, {
      cookie: member.cookie,
    });
    expect(byMember.status).toBe(403);
  });

  it('anyone can leave, except the last owner', async () => {
    const { orgId, owner, member } = await org('leave');
    const left = await api.req('DELETE', `/api/v1/orgs/${orgId}/members/${member.userId}`, {
      cookie: member.cookie,
    });
    expect(left.status).toBe(204);
    const r = await api.req('DELETE', `/api/v1/orgs/${orgId}/members/${owner.userId}`, {
      cookie: owner.cookie,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('last_owner');
  });

  it('removing an unknown or other-org user is 404', async () => {
    const { orgId, owner } = await org('rm404');
    const other = await orgWithRoles(api, 'rm404b');
    const r = await api.req('DELETE', `/api/v1/orgs/${orgId}/members/${other.member.userId}`, {
      cookie: owner.cookie,
    });
    expect(r.status).toBe(404);
  });
});

describe('transfer ownership', () => {
  it('owner transfers to a member and steps down to admin', async () => {
    const { orgId, owner, member } = await org('xfer');
    const r = await api.req('POST', `/api/v1/orgs/${orgId}/transfer-ownership`, {
      cookie: owner.cookie,
      body: { userId: member.userId, newRoleForSelf: 'admin' },
    });
    expect(r.status).toBe(200);
    expect(await role(orgId, member.userId)).toBe('owner');
    expect(await role(orgId, owner.userId)).toBe('admin');
  });

  it('admin cannot transfer; transfer to a non-member is 404', async () => {
    const { orgId, owner, admin, member } = await org('xfer2');
    const url = `/api/v1/orgs/${orgId}/transfer-ownership`;
    const byAdmin = await api.req('POST', url, {
      cookie: admin.cookie,
      body: { userId: member.userId, newRoleForSelf: 'admin' },
    });
    expect(byAdmin.status).toBe(403);
    const toStranger = await api.req('POST', url, {
      cookie: owner.cookie,
      body: { userId: randomUUID(), newRoleForSelf: 'admin' },
    });
    expect(toStranger.status).toBe(404);
  });
});
