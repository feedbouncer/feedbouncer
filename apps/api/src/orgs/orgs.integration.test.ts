import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { OrgsService } from './orgs.service.js';
import {
  login,
  orgWithRoles,
  PASSWORD,
  startTestApi,
  verifiedUser,
  type OrgFixture,
  type TestApi,
  type TestUser,
} from '../testing/harness.js';

let api: TestApi;
// Sign-ups are rate limited per test file, so later tests reuse these users.
let shared: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
let stranger: TestUser;
beforeAll(async () => {
  api = await startTestApi();
});
afterAll(() => api.close());

describe('organizations', () => {
  it('a verified user creates an org with a first brand and becomes owner', async () => {
    const u = await verifiedUser(api, 'oc');
    const r = await api.req('POST', '/api/v1/orgs', {
      cookie: u.cookie,
      body: { name: '  Acme Inc ', brandName: 'Acme Shoes' },
    });
    expect(r.status).toBe(201);
    expect(r.body.organization.name).toBe('Acme Inc');
    expect(r.body.brand.name).toBe('Acme Shoes');
    const got = await api.req('GET', `/api/v1/orgs/${r.body.organization.id}`, {
      cookie: u.cookie,
    });
    expect(got.body.role).toBe('owner');
    const audit = await api.pool.query(
      'SELECT action FROM audit_event WHERE organization_id = $1 ORDER BY sequence',
      [r.body.organization.id],
    );
    expect(audit.rows.map((x) => x.action)).toEqual(['organization.created', 'brand.created']);
  });

  it('creates an org without a brand', async () => {
    const u = await verifiedUser(api, 'nobrand');
    stranger = u;
    const r = await api.req('POST', '/api/v1/orgs', { cookie: u.cookie, body: { name: 'Solo' } });
    expect(r.status).toBe(201);
    expect(r.body.brand).toBeNull();
  });

  it('rejects unknown fields and blank names', async () => {
    const u = await verifiedUser(api, 'badbody');
    const extra = await api.req('POST', '/api/v1/orgs', {
      cookie: u.cookie,
      body: { name: 'X', role: 'owner' },
    });
    const blank = await api.req('POST', '/api/v1/orgs', { cookie: u.cookie, body: { name: '  ' } });
    expect([extra.status, blank.status]).toEqual([400, 400]);
    expect(extra.body.error.code).toBe('invalid_request');
  });

  it('an unverified user cannot create an org', async () => {
    await api.req('POST', '/api/v1/auth/sign-up', {
      body: { email: 'unv2@x.test', password: PASSWORD, name: 'U' },
    });
    const cookie = await login(api, 'unv2@x.test');
    const r = await api.req('POST', '/api/v1/orgs', { cookie, body: { name: 'Nope' } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('email_not_verified');
    const n = await api.pool.query(
      "SELECT count(*)::int AS n FROM organization WHERE name = 'Nope'",
    );
    expect(n.rows[0].n).toBe(0);
  });

  it('a user in several orgs has an independent role in each and lists only their orgs', async () => {
    const a = await verifiedUser(api, 'multi-a');
    const b = await verifiedUser(api, 'multi-b');
    const orgA = (await api.req('POST', '/api/v1/orgs', { cookie: a.cookie, body: { name: 'A' } }))
      .body.organization.id;
    const orgB = (await api.req('POST', '/api/v1/orgs', { cookie: b.cookie, body: { name: 'B' } }))
      .body.organization.id;
    await api.pool.query(
      "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'member')",
      [orgB, a.userId],
    );
    const list = await api.req('GET', '/api/v1/orgs', { cookie: a.cookie });
    expect(
      list.body.organizations.map((o: { organization: { id: string }; role: string }) => [
        o.organization.id,
        o.role,
      ]),
    ).toEqual([
      [orgA, 'owner'],
      [orgB, 'member'],
    ]);
  });

  it('rename requires org.update and is audited; delete requires owner and the exact name', async () => {
    const { owner, admin, member, orgId } = await orgWithRoles(api, 'ren');
    shared = { owner, admin, member };
    const patch = (cookie: string, name: string) =>
      api.req('PATCH', `/api/v1/orgs/${orgId}`, { cookie, body: { name } });
    expect((await patch(member.cookie, 'X')).status).toBe(403);
    const renamed = await patch(admin.cookie, 'Renamed');
    expect(renamed.status).toBe(200);
    expect(renamed.body.organization.name).toBe('Renamed');
    const audit = await api.pool.query(
      "SELECT actor_user_id FROM audit_event WHERE organization_id = $1 AND action = 'organization.renamed'",
      [orgId],
    );
    expect(audit.rows.map((r) => r.actor_user_id)).toEqual([admin.userId]);

    const del = (cookie: string, confirmName: string) =>
      api.req('DELETE', `/api/v1/orgs/${orgId}`, { cookie, body: { confirmName } });
    expect((await del(admin.cookie, 'Renamed')).status).toBe(403);
    const wrong = await del(owner.cookie, 'renamed');
    expect([wrong.status, wrong.body.error.code]).toEqual([400, 'confirmation_mismatch']);
    expect((await del(owner.cookie, 'Renamed')).status).toBe(204);
    expect((await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie: owner.cookie })).status).toBe(
      404,
    );
    const left = await api.pool.query(
      'SELECT (SELECT count(*)::int FROM membership WHERE organization_id = $1) AS m, (SELECT count(*)::int FROM audit_event WHERE organization_id = $1) AS a',
      [orgId],
    );
    expect(left.rows[0]).toEqual({ m: 0, a: 0 });
  });

  it('non-members get 404 on delete, and bad delete or rename bodies get 400', async () => {
    const { owner, orgId } = await orgWithRoles(api, 'del400', shared);
    const del = (cookie: string, body?: unknown) =>
      api.req('DELETE', `/api/v1/orgs/${orgId}`, {
        cookie,
        ...(body === undefined ? {} : { body }),
      });
    expect((await del(stranger.cookie, { confirmName: 'del400 Org' })).status).toBe(404);
    expect((await del(owner.cookie)).status).toBe(400);
    expect((await del(owner.cookie, { confirmName: 'del400 Org', force: true })).status).toBe(400);
    const patch = await api.req('PATCH', `/api/v1/orgs/${orgId}`, {
      cookie: owner.cookie,
      body: { name: 'Y', role: 'owner' },
    });
    expect(patch.status).toBe(400);
    const still = await api.pool.query('SELECT name FROM organization WHERE id = $1', [orgId]);
    expect(still.rows[0].name).toBe('del400 Org');
  });

  describe('delete requires platform access to be removed first', () => {
    // Smallest well-formed envelope v1 for key id "k1" (the table CHECK rejects anything else).
    const envelope = Buffer.concat([
      Buffer.from([1, 2]),
      Buffer.from('k1'),
      Buffer.from([0, 1]),
      Buffer.alloc(1 + 12 + 16 + 1),
    ]);
    const connected = async (label: string, status: 'active' | 'revoked', secret: boolean) => {
      const f = await orgWithRoles(api, label, shared);
      const conn = await api.pool.query<{ id: string }>(
        `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
         VALUES ($1, $2, 'facebook', $3, $4) RETURNING id`,
        [f.orgId, f.brandId, `page-${randomUUID()}`, status],
      );
      if (secret)
        await api.pool.query(
          `INSERT INTO connection_secret (organization_id, brand_id, connection_id, kind, key_id, encrypted_value)
           VALUES ($1, $2, $3, 'access_token', 'k1', $4)`,
          [f.orgId, f.brandId, conn.rows[0]!.id, envelope],
        );
      return f;
    };
    const del = (f: OrgFixture, label: string) =>
      api.req('DELETE', `/api/v1/orgs/${f.orgId}`, {
        cookie: f.owner.cookie,
        body: { confirmName: `${label} Org` },
      });
    const exists = async (orgId: string) =>
      (await api.pool.query('SELECT 1 FROM organization WHERE id = $1', [orgId])).rowCount;

    it('delete refused with connections_active while a connection is active', async () => {
      const f = await connected('del-active', 'active', false);
      const r = await del(f, 'del-active');
      expect([r.status, r.body.error.code]).toEqual([409, 'connections_active']);
      expect(await exists(f.orgId)).toBe(1);
    });

    it('delete refused while a revoked connection still has connection_secret rows', async () => {
      const f = await connected('del-secret', 'revoked', true);
      const r = await del(f, 'del-secret');
      expect([r.status, r.body.error.code]).toEqual([409, 'connections_active']);
      expect(await exists(f.orgId)).toBe(1);
    });

    it('delete succeeds once all connections are revoked and secrets are gone', async () => {
      const f = await connected('del-clean', 'revoked', false);
      expect((await del(f, 'del-clean')).status).toBe(204);
      expect(await exists(f.orgId)).toBe(0);
    });
  });

  describe('workspace timezone', () => {
    const patch = (orgId: string, cookie: string, body: unknown) =>
      api.req('PATCH', `/api/v1/orgs/${orgId}`, { cookie, body });

    it('owner sets timezone Europe/Berlin → 200 and GET shows it', async () => {
      const { owner, orgId } = await orgWithRoles(api, 'tz-set', shared);
      const before = await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie: owner.cookie });
      expect(before.body.organization).toMatchObject({ timezone: 'UTC', timezoneSet: false });
      const r = await patch(orgId, owner.cookie, { timezone: 'Europe/Berlin' });
      expect(r.status).toBe(200);
      expect(r.body.organization).toMatchObject({
        name: 'tz-set Org',
        timezone: 'Europe/Berlin',
        timezoneSet: true,
      });
      const got = await api.req('GET', `/api/v1/orgs/${orgId}`, { cookie: owner.cookie });
      expect(got.body.organization).toMatchObject({
        timezone: 'Europe/Berlin',
        timezoneSet: true,
      });
      const audit = await api.pool.query(
        "SELECT actor_user_id, details FROM audit_event WHERE organization_id = $1 AND action = 'organization.timezone_updated'",
        [orgId],
      );
      expect(audit.rows).toEqual([
        { actor_user_id: owner.userId, details: { timezone: 'Europe/Berlin' } },
      ]);
    });

    it('member → 403', async () => {
      const { member, orgId } = await orgWithRoles(api, 'tz-member', shared);
      expect((await patch(orgId, member.cookie, { timezone: 'Europe/Berlin' })).status).toBe(403);
    });

    it.each(['Japan', 'GMT', 'EST5EDT'])(
      '%s (no region separator) → 400 invalid_timezone',
      async (timezone) => {
        const { owner, orgId } = await orgWithRoles(api, `tz-${timezone}`, shared);
        const r = await patch(orgId, owner.cookie, { timezone });
        expect([r.status, r.body.error.code]).toEqual([400, 'invalid_timezone']);
      },
    );

    it("'Mars/Olympus' → 400 invalid_timezone", async () => {
      const { owner, orgId } = await orgWithRoles(api, 'tz-mars', shared);
      const r = await patch(orgId, owner.cookie, { timezone: 'Mars/Olympus' });
      expect([r.status, r.body.error.code]).toEqual([400, 'invalid_timezone']);
      const row = await api.pool.query(
        'SELECT timezone, timezone_set_at FROM organization WHERE id = $1',
        [orgId],
      );
      expect(row.rows[0]).toEqual({ timezone: 'UTC', timezone_set_at: null });
    });

    it('org B owner → 404', async () => {
      const { orgId } = await orgWithRoles(api, 'tz-a', shared);
      const r = await patch(orgId, stranger.cookie, { timezone: 'Europe/Berlin' });
      expect(r.status).toBe(404);
    });

    it('rename still works alone', async () => {
      const { owner, orgId } = await orgWithRoles(api, 'tz-ren', shared);
      const r = await patch(orgId, owner.cookie, { name: 'Only name' });
      expect(r.status).toBe(200);
      expect(r.body.organization).toMatchObject({
        name: 'Only name',
        timezone: 'UTC',
        timezoneSet: false,
      });
      expect((await patch(orgId, owner.cookie, {})).status).toBe(400);
      const audit = await api.pool.query(
        'SELECT action FROM audit_event WHERE organization_id = $1 ORDER BY sequence',
        [orgId],
      );
      expect(audit.rows.map((x) => x.action)).not.toContain('organization.timezone_updated');
    });
  });

  describe('mutations re-read the actor under the organization lock', () => {
    const ctxFor = (organizationId: string, actorUserId: string, role: OrgContext['role']) =>
      ({ organizationId, actorUserId, role, grants: [] }) as OrgContext;
    const fail = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return e as ApiError;
      }
      throw new Error('expected rejection');
    };

    it('remove: an actor removed after the guard gets 404, not 403', async () => {
      const { orgId, admin } = await orgWithRoles(api, 'race-del', shared);
      await api.pool.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
        orgId,
        admin.userId,
      ]);
      const svc = new OrgsService(api.deps);
      const err = await fail(svc.remove(ctxFor(orgId, admin.userId, 'owner'), 'race-del Org'));
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(404);
      const n = await api.pool.query('SELECT 1 FROM organization WHERE id = $1', [orgId]);
      expect(n.rowCount).toBe(1);
    });

    it('remove: an actor demoted after the guard gets 403 and nothing is deleted', async () => {
      const { orgId, admin } = await orgWithRoles(api, 'race-demote', shared);
      const svc = new OrgsService(api.deps);
      const err = await fail(svc.remove(ctxFor(orgId, admin.userId, 'owner'), 'race-demote Org'));
      expect(err.status).toBe(403);
      expect(
        (await api.pool.query('SELECT 1 FROM organization WHERE id = $1', [orgId])).rowCount,
      ).toBe(1);
    });

    it('rename: a removed actor gets 404 and a demoted actor gets 403', async () => {
      const { orgId, admin, member } = await orgWithRoles(api, 'race-ren', shared);
      await api.pool.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
        orgId,
        admin.userId,
      ]);
      const svc = new OrgsService(api.deps);
      expect(
        (await fail(svc.update(ctxFor(orgId, admin.userId, 'admin'), { name: 'Z' }))).status,
      ).toBe(404);
      expect(
        (await fail(svc.update(ctxFor(orgId, member.userId, 'admin'), { name: 'Z' }))).status,
      ).toBe(403);
      const row = await api.pool.query('SELECT name FROM organization WHERE id = $1', [orgId]);
      expect(row.rows[0].name).toBe('race-ren Org');
    });

    it('rename racing a delete ends 404', async () => {
      const { orgId, owner } = await orgWithRoles(api, 'race-gone', shared);
      await api.pool.query('DELETE FROM organization WHERE id = $1', [orgId]);
      const svc = new OrgsService(api.deps);
      expect(
        (await fail(svc.update(ctxFor(orgId, owner.userId, 'owner'), { name: 'Z' }))).status,
      ).toBe(404);
    });

    it('create rolls back the organization and membership when the brand insert fails', async () => {
      const u = stranger;
      const svc = new OrgsService(api.deps);
      const name = `Rollback ${randomUUID()}`;
      const before = await api.pool.query(
        'SELECT count(*)::int AS m FROM membership WHERE user_id = $1',
        [u.userId],
      );
      // A NUL character is rejected by Postgres text columns, so the brand insert fails.
      await expect(
        svc.create({ id: u.userId, emailVerified: true } as never, {
          name,
          brandName: 'bad\u0000name',
        }),
      ).rejects.toThrow();
      const left = await api.pool.query(
        'SELECT (SELECT count(*)::int FROM organization WHERE name = $1) AS o, (SELECT count(*)::int FROM membership WHERE user_id = $2) AS m',
        [name, u.userId],
      );
      expect(left.rows[0]).toEqual({ o: 0, m: before.rows[0].m });
    });
  });
});
