import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

type WithConnection = OrgFixture & { connectionId: string };

let api: TestApi;
let A: WithConnection;
let B: WithConnection;
let extraBrandId: string;

const healthUrl = (orgId: string, brandId: string) =>
  `/api/v1/orgs/${orgId}/brands/${brandId}/connections/health`;

async function addConnection(f: OrgFixture, brandId: string, ext: string, platform = 'youtube') {
  const { rows } = await api.pool.query(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name)
     VALUES ($1, $2, $3, $4, 'acct') RETURNING id`,
    [f.orgId, brandId, platform, ext],
  );
  return rows[0].id as string;
}

async function addBrand(name: string): Promise<string> {
  const r = await api.req('POST', `/api/v1/orgs/${A.orgId}/brands`, {
    cookie: A.owner.cookie,
    body: { name },
  });
  return r.body.brand.id as string;
}

beforeAll(async () => {
  api = await startTestApi();
  const a = await orgWithRoles(api, 'a');
  const b = await orgWithRoles(api, 'b');
  A = { ...a, connectionId: await addConnection(a, a.brandId, `ext-${a.orgId}`) };
  B = { ...b, connectionId: await addConnection(b, b.brandId, `ext-${b.orgId}`) };
  await api.pool.query(
    `INSERT INTO connection_sync (connection_id, organization_id, brand_id, last_success_at)
     VALUES ($1, $2, $3, now() - interval '2 minutes')`,
    [A.connectionId, A.orgId, A.brandId],
  );
  extraBrandId = await addBrand('second brand');
});
afterAll(() => api.close());

describe('connection health endpoint', () => {
  it("lists health for the caller's brand only", async () => {
    const r = await api.req('GET', healthUrl(A.orgId, A.brandId), { cookie: A.owner.cookie });
    expect(r.status).toBe(200);
    expect(r.body.connections).toEqual([
      expect.objectContaining({
        connectionId: A.connectionId,
        platform: 'youtube',
        status: 'healthy',
        reason: 'ok',
        lastErrorCode: null,
        consecutiveFailures: 0,
        ingestLagSeconds: 0,
      }),
    ]);
    expect(r.body.connections[0].stalenessSeconds).toBeGreaterThanOrEqual(100);
    expect(JSON.stringify(r.body)).not.toContain(B.orgId);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('admins may read, members may not', async () => {
    const admin = await api.req('GET', healthUrl(A.orgId, A.brandId), { cookie: A.admin.cookie });
    expect(admin.status).toBe(200);
    const member = await api.req('GET', healthUrl(A.orgId, A.brandId), { cookie: A.member.cookie });
    expect(member.status).toBe(403);
  });

  it('requires a session', async () => {
    const r = await api.req('GET', healthUrl(A.orgId, A.brandId));
    expect(r.status).toBe(401);
  });

  it("cross-tenant: another org's brand under my org is 404, same body as a missing brand", async () => {
    const cross = await api.req('GET', healthUrl(A.orgId, B.brandId), { cookie: A.owner.cookie });
    const missing = await api.req(
      'GET',
      healthUrl(A.orgId, '00000000-0000-4000-8000-000000000000'),
      {
        cookie: A.owner.cookie,
      },
    );
    expect(cross.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(cross.body).toEqual(missing.body);
  });

  it('cross-tenant: another org is 404', async () => {
    const r = await api.req('GET', healthUrl(B.orgId, B.brandId), { cookie: A.owner.cookie });
    expect(r.status).toBe(404);
  });

  it('a malformed brand id is 404', async () => {
    const r = await api.req('GET', healthUrl(A.orgId, 'not-a-uuid'), { cookie: A.owner.cookie });
    expect(r.status).toBe(404);
  });

  it('a new connection reports pending_first_sync', async () => {
    const r = await api.req('GET', healthUrl(B.orgId, B.brandId), { cookie: B.owner.cookie });
    expect(r.body.connections[0]).toMatchObject({
      status: 'pending_first_sync',
      stalenessSeconds: null,
      lastSuccessAt: null,
    });
  });

  it('only returns the connections of the requested brand', async () => {
    const id = await addConnection(A, extraBrandId, 'ext-extra');
    const r = await api.req('GET', healthUrl(A.orgId, extraBrandId), { cookie: A.owner.cookie });
    expect(r.body.connections.map((c: { connectionId: string }) => c.connectionId)).toEqual([id]);
  });

  it('maps raw status reasons to a bounded set and exposes error codes only', async () => {
    const brandId = await addBrand('reasons brand');
    const raw = await addConnection(A, brandId, 'ext-raw');
    await api.pool.query(
      `UPDATE connection SET status = 'reconnect_required', status_reason = 'credential_some_internal_detail'
        WHERE id = $1`,
      [raw],
    );
    const known = await addConnection(A, brandId, 'ext-known');
    await api.pool.query(
      `UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_refresh_rejected'
        WHERE id = $1`,
      [known],
    );
    const odd = await addConnection(A, brandId, 'ext-odd');
    await api.pool.query(
      `UPDATE connection SET status = 'error', status_reason = 'secret_looking_detail' WHERE id = $1`,
      [odd],
    );
    await api.pool.query(
      `INSERT INTO connection_sync (connection_id, organization_id, brand_id, last_failure_at,
                                    last_error_code, last_error_class, consecutive_failures)
       VALUES ($1, $2, $3, now(), 'rate_limited', 'rate_limited', 2)`,
      [odd, A.orgId, brandId],
    );
    const r = await api.req('GET', healthUrl(A.orgId, brandId), { cookie: A.owner.cookie });
    const by = new Map(
      r.body.connections.map((c: { connectionId: string }) => [c.connectionId, c]),
    );
    expect(by.get(raw)).toMatchObject({
      status: 'needs_reconnection',
      reason: 'credential_unavailable',
    });
    expect(by.get(known)).toMatchObject({
      status: 'needs_reconnection',
      reason: 'oauth_refresh_rejected',
    });
    expect(by.get(odd)).toMatchObject({
      status: 'degraded',
      reason: 'connection_error',
      lastErrorCode: 'rate_limited',
      consecutiveFailures: 2,
    });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('some_internal_detail');
    expect(text).not.toContain('secret_looking_detail');
    expect(Object.keys(r.body.connections[0]).sort()).toEqual(
      [
        'connectionId',
        'platform',
        'status',
        'reason',
        'lastSuccessAt',
        'lastErrorCode',
        'lastErrorAt',
        'consecutiveFailures',
        'stalenessSeconds',
        'ingestLagSeconds',
      ].sort(),
    );
  });

  it('does not write connection_sync', async () => {
    const q = () =>
      api.pool.query('SELECT * FROM connection_sync ORDER BY connection_id').then((r) => r.rows);
    const before = await q();
    await api.req('GET', healthUrl(A.orgId, A.brandId), { cookie: A.owner.cookie });
    expect(await q()).toEqual(before);
  });
});
