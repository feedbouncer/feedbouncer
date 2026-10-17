import { randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@feedbouncer/authz';
import { withTransaction } from '@feedbouncer/db';
import {
  orgWithRoles,
  startTestApi,
  verifiedUser,
  type OrgFixture,
  type TestApi,
} from '../testing/harness.js';
import { OrgAccessGuard, type OrgContext } from './org-access.guard.js';
import { lockedActor } from './org-lock.js';

let api: TestApi;
let users: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
let outsider: Awaited<ReturnType<typeof verifiedUser>>;
beforeAll(async () => {
  api = await startTestApi();
  // Sign-ups are budgeted per app instance, so every org case reuses these users.
  users = await orgWithRoles(api, 'shared');
  outsider = await verifiedUser(api, 'outsider');
});
const newOrg = (label: string) => orgWithRoles(api, label, users);
afterAll(() => api.close());

describe('GET /api/v1/me', () => {
  it('without a cookie is 401 unauthenticated', async () => {
    const r = await api.req('GET', '/api/v1/me');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthenticated');
  });

  it('with a forged cookie is 401', async () => {
    const r = await api.req('GET', '/api/v1/me', { cookie: 'fb.session_token=forged.value' });
    expect(r.status).toBe(401);
  });

  it('returns the user and memberships, and no secrets', async () => {
    const u = await verifiedUser(api, 'me');
    const r = await api.req('GET', '/api/v1/me', { cookie: u.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      user: { id: u.userId, email: u.email, name: 'Test User', emailVerified: true },
      memberships: [],
    });
    expect(JSON.stringify(r.body)).not.toMatch(/token|password|hash/i);
  });

  it('lists memberships ordered by organization name, and reads them fresh', async () => {
    const u = await verifiedUser(api, 'me-orgs');
    const other = await verifiedUser(api, 'me-orgs-owner');
    const org = async (name: string, role: string) => {
      const o = await api.pool.query<{ id: string }>(
        'INSERT INTO organization (name) VALUES ($1) RETURNING id',
        [name],
      );
      await api.pool.query(
        'INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)',
        [o.rows[0]!.id, u.userId, role],
      );
      return o.rows[0]!.id;
    };
    const b = await org('Beta', 'member');
    // An organization must keep an owner, so someone else owns Beta.
    await api.pool.query(
      "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
      [b, other.userId],
    );
    const a = await org('Alpha', 'owner');
    const first = await api.req('GET', '/api/v1/me', { cookie: u.cookie });
    expect(first.body.memberships).toEqual([
      { organizationId: a, organizationName: 'Alpha', role: 'owner' },
      { organizationId: b, organizationName: 'Beta', role: 'member' },
    ]);
    await api.pool.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
      b,
      u.userId,
    ]);
    const second = await api.req('GET', '/api/v1/me', { cookie: u.cookie });
    expect(second.body.memberships).toEqual([
      { organizationId: a, organizationName: 'Alpha', role: 'owner' },
    ]);
  });
});

describe('organization access guard', () => {
  it('a non-member gets 404 for an existing org, identical to a random UUID and a malformed id', async () => {
    const { orgId } = await newOrg('g404');
    const a = await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie: outsider.cookie });
    const b = await api.req('GET', `/api/v1/orgs/${randomUUID()}`, { cookie: outsider.cookie });
    const c = await api.req('GET', '/api/v1/orgs/not-a-uuid', { cookie: outsider.cookie });
    expect([a.status, b.status, c.status]).toEqual([404, 404, 404]);
    expect(a.body).toEqual(b.body);
    expect(b.body).toEqual(c.body);
  });

  it('an insufficient role in an own org is 403, not 404', async () => {
    const { orgId, member } = await newOrg('g403');
    const r = await api.req('PATCH', `/api/v1/orgs/${orgId}`, {
      cookie: member.cookie,
      body: { name: 'Nope' },
    });
    expect([r.status, r.body.error.code]).toEqual([403, 'forbidden']);
  });

  it('role changes and removals take effect on the very next request', async () => {
    const { orgId, admin } = await newOrg('gnext');
    const rename = (name: string) =>
      api.req('PATCH', `/api/v1/orgs/${orgId}`, { cookie: admin.cookie, body: { name } });
    expect((await rename('One')).status).toBe(200);
    await api.pool.query(
      "UPDATE membership SET role = 'member' WHERE organization_id = $1 AND user_id = $2",
      [orgId, admin.userId],
    );
    expect((await rename('Two')).status).toBe(403);
    await api.pool.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
      orgId,
      admin.userId,
    ]);
    expect((await rename('Three')).status).toBe(404);
  });

  it('a route without @RequireCapability fails closed, whoever asks', async () => {
    const { orgId, owner } = await newOrg('gnocap');
    const guard = new OrgAccessGuard(api.deps, new Reflector());
    const handler = () => undefined;
    const contextFor = (userId: string, id: string) =>
      ({
        getHandler: () => handler,
        switchToHttp: () => ({
          getRequest: () => ({
            params: { orgId: id },
            user: { id: userId },
            routeOptions: { url: '/x/:orgId' },
          }),
        }),
      }) as unknown as ExecutionContext;
    await expect(guard.canActivate(contextFor(owner.userId, orgId))).rejects.toThrow(
      /no @RequireCapability/,
    );
    await expect(guard.canActivate(contextFor(randomUUID(), 'not-a-uuid'))).rejects.toThrow(
      /no @RequireCapability/,
    );
  });
});

describe('lockedActor', () => {
  const ctxFor = (organizationId: string, actorUserId: string, role: Role): OrgContext => ({
    organizationId,
    actorUserId,
    grants: [],
    role,
  });
  const inTx = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> =>
    withTransaction(api.pool, fn);

  it('re-reads the role in the transaction instead of trusting the guard context', async () => {
    const { orgId, admin } = await newOrg('lk-role');
    await api.pool.query(
      "UPDATE membership SET role = 'member' WHERE organization_id = $1 AND user_id = $2",
      [orgId, admin.userId],
    );
    const role = await inTx((c) => lockedActor(c, ctxFor(orgId, admin.userId, 'admin')));
    expect(role).toBe('member');
  });

  it('is 404 when the actor or the organization is gone', async () => {
    const { orgId, member } = await newOrg('lk-gone');
    await api.pool.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
      orgId,
      member.userId,
    ]);
    await expect(
      inTx((c) => lockedActor(c, ctxFor(orgId, member.userId, 'member'))),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      inTx((c) => lockedActor(c, ctxFor(randomUUID(), member.userId, 'member'))),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('holds the organization row lock until the transaction ends', async () => {
    const { orgId, owner } = await newOrg('lk-lock');
    await inTx(async (c) => {
      await lockedActor(c, ctxFor(orgId, owner.userId, 'owner'));
      const other = await api.pool.connect();
      try {
        await other.query('BEGIN');
        await expect(
          other.query('SELECT 1 FROM organization WHERE id = $1 FOR UPDATE NOWAIT', [orgId]),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await other.query('ROLLBACK');
        other.release();
      }
    });
  });
});
