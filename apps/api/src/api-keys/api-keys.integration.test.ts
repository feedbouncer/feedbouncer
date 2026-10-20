import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  orgWithRoles,
  startTestApi,
  verifiedUser,
  type OrgFixture,
  type TestApi,
} from '../testing/harness.js';

const KEY_RE = /^fbk_[a-z2-7]{16}_[A-Za-z0-9_-]{43}$/;

let api: TestApi;
let org: OrgFixture;

beforeAll(async () => {
  api = await startTestApi();
  const owner = await verifiedUser(api, 'ak-owner');
  const admin = await verifiedUser(api, 'ak-admin');
  const member = await verifiedUser(api, 'ak-member');
  org = await orgWithRoles(api, 'akA', { owner, admin, member });
});
afterAll(() => api.close());

const base = () => `/api/v1/orgs/${org.orgId}/api-keys`;
const create = (cookie: string, name: string, scope = 'read') =>
  api.req('POST', base(), { cookie, body: { name, scope } });

describe('api keys API', () => {
  const tokens: string[] = [];

  for (const role of ['owner', 'admin'] as const) {
    it(`${role} creates, lists and revokes without the token leaking`, async () => {
      const cookie = org[role].cookie;
      const created = await create(cookie, `${role} key`, 'write');
      expect(created.status).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      const body = created.body;
      expect(body.token).toMatch(KEY_RE);
      tokens.push(body.token);
      expect(body.key).toMatchObject({
        name: `${role} key`,
        scope: 'write',
        status: 'active',
        lastUsedAt: null,
        revokedAt: null,
      });
      expect(body.token).toContain(body.key.prefix);
      const list = await api.raw('GET', base(), { headers: { cookie } });
      expect(list.status).toBe(200);
      expect(list.text).not.toContain('"token"');
      expect(list.text).not.toMatch(/fbk_[a-z2-7]{16}_/);
      expect(JSON.parse(list.text).items.map((k: { id: string }) => k.id)).toContain(body.key.id);
      const revoked = await api.req('POST', `${base()}/${body.key.id}/revoke`, { cookie });
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({ id: body.key.id, status: 'revoked' });
    });
  }

  it('a member gets 403 forbidden on list, create and revoke', async () => {
    const cookie = org.member.cookie;
    const id = '00000000-0000-4000-8000-000000000001';
    for (const r of [
      await api.req('GET', base(), { cookie }),
      await create(cookie, 'nope'),
      await api.req('POST', `${base()}/${id}/revoke`, { cookie }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('forbidden');
    }
  });

  it('rejects invalid bodies', async () => {
    const r = await create(org.admin.cookie, '', 'read');
    expect(r.status).toBe(400);
    expect((await create(org.admin.cookie, 'x', 'admin')).status).toBe(400);
  });

  it('creates a moderate-scope key', async () => {
    const r = await create(org.admin.cookie, 'moderation only', 'moderate');
    expect(r.status).toBe(201);
    expect(r.body.key.scope).toBe('moderate');
  });

  it('refuses a duplicate active name, then allows it after revoke', async () => {
    const first = await create(org.admin.cookie, 'dup');
    expect(first.status).toBe(201);
    const dup = await create(org.admin.cookie, 'dup');
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({
      code: 'api_key_name_taken',
      message: 'An active API key already uses this name.',
    });
    await api.req('POST', `${base()}/${first.body.key.id}/revoke`, { cookie: org.admin.cookie });
    expect((await create(org.admin.cookie, 'dup')).status).toBe(201);
  });

  it('the 11th active key is refused', async () => {
    const active = await api.pool.query(
      'SELECT count(*)::int AS n FROM api_key WHERE organization_id = $1 AND revoked_at IS NULL',
      [org.orgId],
    );
    for (let i = active.rows[0].n; i < 10; i++) {
      expect((await create(org.owner.cookie, `fill ${i}`)).status).toBe(201);
    }
    const r = await create(org.owner.cookie, 'eleventh');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'api_key_limit_reached',
      message: 'This workspace already has 10 active API keys. Revoke one to create another.',
    });
  });

  it('revoking twice returns 200 both times with the same revokedAt', async () => {
    const list = await api.req('GET', base(), { cookie: org.admin.cookie });
    const key = list.body.items.find((k: { status: string }) => k.status === 'active');
    const a = await api.req('POST', `${base()}/${key.id}/revoke`, { cookie: org.admin.cookie });
    const b = await api.req('POST', `${base()}/${key.id}/revoke`, { cookie: org.admin.cookie });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.revokedAt).not.toBeNull();
    expect(b.body.revokedAt).toBe(a.body.revokedAt);
  });

  it('an unknown or malformed key id is 404', async () => {
    for (const id of ['00000000-0000-4000-8000-0000000000ff', 'nope']) {
      const r = await api.req('POST', `${base()}/${id}/revoke`, { cookie: org.admin.cookie });
      expect(r.status).toBe(404);
    }
  });

  it('logs never contain a created token', () => {
    expect(tokens.length).toBeGreaterThan(0);
    const logs = api.logLines.join('\n');
    for (const t of tokens) expect(logs).not.toContain(t);
  });
});
