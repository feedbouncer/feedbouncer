import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrandsService } from './brands.service.js';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

let api: TestApi;
// Sign-ups are rate limited per test file, so every organization reuses these users.
let shared: Pick<OrgFixture, 'owner' | 'admin' | 'member'>;
beforeAll(async () => {
  api = await startTestApi();
  const first = await orgWithRoles(api, 'br');
  shared = { owner: first.owner, admin: first.admin, member: first.member };
});
afterAll(() => api.close());

const brandsUrl = (orgId: string) => `/api/v1/orgs/${orgId}/brands`;

describe('brands', () => {
  it('owner and admin create, rename and archive; member reads but cannot modify', async () => {
    const { orgId, owner, admin, member } = await orgWithRoles(api, 'br2', shared);
    const created = await api.req('POST', brandsUrl(orgId), {
      cookie: admin.cookie,
      body: { name: 'Second' },
    });
    expect(created.status).toBe(201);
    const id = created.body.brand.id;
    const one = `${brandsUrl(orgId)}/${id}`;
    expect(
      (await api.req('POST', brandsUrl(orgId), { cookie: member.cookie, body: { name: 'M' } }))
        .status,
    ).toBe(403);
    expect(
      (await api.req('PATCH', one, { cookie: member.cookie, body: { name: 'M' } })).status,
    ).toBe(403);
    expect(
      (await api.req('POST', `${one}/archive`, { cookie: member.cookie, body: {} })).status,
    ).toBe(403);
    expect((await api.req('GET', one, { cookie: member.cookie })).status).toBe(200);
    const renamed = await api.req('PATCH', one, {
      cookie: owner.cookie,
      body: { name: 'Renamed' },
    });
    expect(renamed.body.brand.name).toBe('Renamed');
    expect(
      (await api.req('POST', `${one}/archive`, { cookie: owner.cookie, body: {} })).status,
    ).toBe(200);
    const audit = await api.pool.query(
      'SELECT action FROM audit_event WHERE organization_id = $1 AND brand_id = $2 ORDER BY sequence',
      [orgId, id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'brand.created',
      'brand.renamed',
      'brand.archived',
    ]);
  });

  it('archived brands are hidden from the default list, kept in the database, and archiving twice is a no-op', async () => {
    const { orgId, owner, brandId } = await orgWithRoles(api, 'arch', shared);
    const one = `${brandsUrl(orgId)}/${brandId}`;
    const first = await api.req('POST', `${one}/archive`, { cookie: owner.cookie, body: {} });
    const second = await api.req('POST', `${one}/archive`, { cookie: owner.cookie, body: {} });
    expect(second.body.brand.archivedAt).toBe(first.body.brand.archivedAt);
    expect((await api.req('GET', brandsUrl(orgId), { cookie: owner.cookie })).body.brands).toEqual(
      [],
    );
    const all = await api.req('GET', `${brandsUrl(orgId)}?includeArchived=true`, {
      cookie: owner.cookie,
    });
    expect(all.body.brands).toHaveLength(1);
    expect((await api.pool.query('SELECT 1 FROM brand WHERE id = $1', [brandId])).rowCount).toBe(1);
    const renamed = await api.req('PATCH', one, { cookie: owner.cookie, body: { name: 'Z' } });
    expect(renamed.status).toBe(409);
    expect(renamed.body.error.code).toBe('brand_archived');
    const audit = await api.pool.query(
      "SELECT 1 FROM audit_event WHERE brand_id = $1 AND action = 'brand.archived'",
      [brandId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('names are unique per org (case/space-insensitive) and may repeat across orgs', async () => {
    const a = await orgWithRoles(api, 'uniqA', shared);
    const b = await orgWithRoles(api, 'uniqB', shared);
    await api.req('POST', brandsUrl(a.orgId), { cookie: a.owner.cookie, body: { name: 'Shared' } });
    const dup = await api.req('POST', brandsUrl(a.orgId), {
      cookie: a.owner.cookie,
      body: { name: ' shared ' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('brand_name_taken');
    const clash = await api.req('PATCH', `${brandsUrl(a.orgId)}/${a.brandId}`, {
      cookie: a.owner.cookie,
      body: { name: 'SHARED' },
    });
    expect(clash.body.error.code).toBe('brand_name_taken');
    const other = await api.req('POST', brandsUrl(b.orgId), {
      cookie: b.owner.cookie,
      body: { name: 'Shared' },
    });
    expect(other.status).toBe(201);
  });

  it('rejects control characters and over-long names with 400', async () => {
    const { orgId, owner } = await orgWithRoles(api, 'bad', shared);
    for (const name of ['a\u0000b', 'x'.repeat(201)]) {
      const r = await api.req('POST', brandsUrl(orgId), { cookie: owner.cookie, body: { name } });
      expect(r.status).toBe(400);
    }
  });

  it('organizationId in the body is rejected (brands cannot be moved or planted)', async () => {
    const { orgId, owner } = await orgWithRoles(api, 'mv', shared);
    const r = await api.req('POST', brandsUrl(orgId), {
      cookie: owner.cookie,
      body: { name: 'N', organizationId: randomUUID() },
    });
    expect(r.status).toBe(400);
  });

  it('a brand id from another organization is 404, and malformed ids are 404', async () => {
    const a = await orgWithRoles(api, 'xa', shared);
    const b = await orgWithRoles(api, 'xb', shared);
    const url = `${brandsUrl(a.orgId)}/${b.brandId}`;
    const cookie = a.owner.cookie;
    expect((await api.req('GET', url, { cookie })).status).toBe(404);
    expect((await api.req('PATCH', url, { cookie, body: { name: 'Q' } })).status).toBe(404);
    expect((await api.req('POST', `${url}/archive`, { cookie, body: {} })).status).toBe(404);
    expect((await api.req('GET', `${brandsUrl(a.orgId)}/nope`, { cookie })).status).toBe(404);
  });

  it('an actor removed after the guard ran gets 404, not 403', async () => {
    const { orgId, admin, brandId } = await orgWithRoles(api, 'gone', shared);
    const svc = new BrandsService(api.deps);
    const ctx = { organizationId: orgId, actorUserId: admin.userId, role: 'admin' as const };
    await api.pool.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
      orgId,
      admin.userId,
    ]);
    await expect(svc.update(ctx, brandId, { name: 'Late' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.create(ctx, 'Late')).rejects.toMatchObject({ status: 404 });
    await expect(svc.archive(ctx, brandId)).rejects.toMatchObject({ status: 404 });
  });

  describe('timezone', () => {
    it('GET brand returns timezone UTC, not yet set', async () => {
      const { orgId, owner, brandId } = await orgWithRoles(api, 'tz0', shared);
      const r = await api.req('GET', `${brandsUrl(orgId)}/${brandId}`, { cookie: owner.cookie });
      expect(r.body.brand).toMatchObject({ timezone: 'UTC', timezoneSet: false });
    });

    it('POST brand with timezone stores it; an unknown zone falls back to UTC', async () => {
      const { orgId, owner } = await orgWithRoles(api, 'tz1', shared);
      const created = await api.req('POST', brandsUrl(orgId), {
        cookie: owner.cookie,
        body: { name: 'Berlin', timezone: 'Europe/Berlin' },
      });
      expect(created.status).toBe(201);
      expect(created.body.brand).toMatchObject({ timezone: 'Europe/Berlin', timezoneSet: true });
      const plain = await api.req('POST', brandsUrl(orgId), {
        cookie: owner.cookie,
        body: { name: 'Plain' },
      });
      expect(plain.body.brand).toMatchObject({ timezone: 'UTC', timezoneSet: false });
      const bad = await api.req('POST', brandsUrl(orgId), {
        cookie: owner.cookie,
        body: { name: 'Mars', timezone: 'Mars/Phobos' },
      });
      expect(bad.status).toBe(201);
      expect(bad.body.brand).toMatchObject({ timezone: 'UTC', timezoneSet: false });
    });

    it("PATCH brand timezone 'America/Los_Angeles' -> timezoneSet true; 'Mars/Phobos' -> 400; member role -> 403", async () => {
      const { orgId, owner, member, brandId } = await orgWithRoles(api, 'tz2', shared);
      const one = `${brandsUrl(orgId)}/${brandId}`;
      const ok = await api.req('PATCH', one, {
        cookie: owner.cookie,
        body: { timezone: 'America/Los_Angeles' },
      });
      expect(ok.status).toBe(200);
      expect(ok.body.brand).toMatchObject({
        name: 'tz2 Brand',
        timezone: 'America/Los_Angeles',
        timezoneSet: true,
      });
      // Intl matches names case-insensitively, Postgres does not: still a 400, and nothing changes.
      for (const timezone of ['Mars/Phobos', 'america/los_angeles']) {
        const bad = await api.req('PATCH', one, { cookie: owner.cookie, body: { timezone } });
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('invalid_request');
      }
      expect((await api.req('GET', one, { cookie: owner.cookie })).body.brand.timezone).toBe(
        'America/Los_Angeles',
      );
      const denied = await api.req('PATCH', one, {
        cookie: member.cookie,
        body: { timezone: 'Asia/Tokyo' },
      });
      expect(denied.status).toBe(403);
      for (const body of [{}, { name: 'x', extra: 1 }]) {
        expect((await api.req('PATCH', one, { cookie: owner.cookie, body })).status).toBe(400);
      }
      const audit = await api.pool.query(
        "SELECT action, details FROM audit_event WHERE brand_id = $1 AND action <> 'brand.created'",
        [brandId],
      );
      expect(audit.rows).toEqual([{ action: 'brand.updated', details: { timezoneChanged: true } }]);
    });

    it('a name-only PATCH leaves the timezone alone', async () => {
      const { orgId, owner, brandId } = await orgWithRoles(api, 'tz3', shared);
      const one = `${brandsUrl(orgId)}/${brandId}`;
      await api.req('PATCH', one, { cookie: owner.cookie, body: { timezone: 'Asia/Tokyo' } });
      const r = await api.req('PATCH', one, { cookie: owner.cookie, body: { name: 'Renamed' } });
      expect(r.body.brand).toMatchObject({
        name: 'Renamed',
        timezone: 'Asia/Tokyo',
        timezoneSet: true,
      });
    });
  });
});
