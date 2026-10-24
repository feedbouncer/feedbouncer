import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgSyncRecorder, buildPgConnectorStack } from '@feedbouncer/connectors';
import { createPool } from '@feedbouncer/db';
import { Secret } from '@feedbouncer/service-runtime';
import { TIKTOK_API_HOST, TIKTOK_ENDPOINTS } from '@feedbouncer/tiktok-business-api';
import { FakeTikTok } from '@feedbouncer/tiktok-business-api/testing';
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
        failedImports: 0,
      }),
    ]);
    expect(r.body.connections[0].stalenessSeconds).toBeGreaterThanOrEqual(100);
    expect(JSON.stringify(r.body)).not.toContain(B.orgId);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('reports dead-lettered ingest jobs as failedImports', async () => {
    await api.pool.query(
      `INSERT INTO job_ledger (organization_id, brand_id, connection_id, platform, job_type, idempotency_key,
                               payload, state, expires_at, dead_letter_reason, dead_lettered_at)
       VALUES ($1, $2, $3, 'youtube', 'comment_ingest', repeat('e', 64), '{}'::jsonb, 'dead_lettered',
               now() + interval '1 day', 'retries_exhausted', now())`,
      [A.orgId, A.brandId, A.connectionId],
    );
    const r = await api.req('GET', healthUrl(A.orgId, A.brandId), { cookie: A.owner.cookie });
    expect(r.body.connections[0].failedImports).toBe(1);
    await api.pool.query('DELETE FROM job_ledger WHERE connection_id = $1', [A.connectionId]);
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
        'failedImports',
        'missingScopes',
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

describe('tiktok connection health', () => {
  const TIKTOK = { appId: '7300000000000001', appSecret: 'tiktok-app-secret-0123456789' };
  let tt: TestApi;
  let fake: FakeTikTok;
  let org: OrgFixture;

  beforeAll(async () => {
    fake = new FakeTikTok(TIKTOK);
    tt = await startTestApi({ tiktok: TIKTOK, tiktokAds: TIKTOK }, { fetch: fake.fetch });
    org = await orgWithRoles(tt, 'tth');
  });
  afterAll(() => tt.close());

  /** A token straight from FakeTikTok's token endpoint. */
  async function token(endpoint: 'ttToken' | 'adOauthToken', authCode: string): Promise<string> {
    const body =
      endpoint === 'ttToken'
        ? { client_id: TIKTOK.appId, client_secret: TIKTOK.appSecret, auth_code: authCode }
        : { app_id: TIKTOK.appId, secret: TIKTOK.appSecret, auth_code: authCode };
    const r = await fake.fetch(
      `https://${TIKTOK_API_HOST}/open_api/v1.3/${TIKTOK_ENDPOINTS[endpoint]}`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return ((await r.json()) as { data: { access_token: string } }).data.access_token;
  }

  async function connected(
    platform: 'tiktok' | 'tiktok_ads',
    externalAccountId: string,
    t: string,
  ) {
    const { scope } = await tt.seedConnection(org, { platform, externalAccountId });
    await tt.deps.connectors!.stack.store.put(scope, 'access_token', new Secret(t), null);
    return scope;
  }

  it('a scope-missing tiktok connection reports needs_reconnection with the missing scope; a tiktok_ads outage leaves the tiktok connection healthy', async () => {
    const revoked = fake.addBusinessAccount({ username: 'revoked' });
    const healthy = fake.addBusinessAccount({ username: 'healthy' });
    const adv = fake.addAdvertiser({ name: 'Ads' });
    const revokedScope = await connected(
      'tiktok',
      revoked.businessId,
      await token('ttToken', revoked.authCode),
    );
    const healthyScope = await connected(
      'tiktok',
      healthy.businessId,
      await token('ttToken', healthy.authCode),
    );
    const adsScope = await connected(
      'tiktok_ads',
      adv.advertiserId,
      await token('adOauthToken', adv.authCode),
    );
    // The worker's runtime: same registry, recording sync state as the poll jobs do.
    const lockPool = createPool(tt.deps.env.databaseUrl, {
      applicationName: 'tth',
      max: 2,
      onIdleError: () => {},
    });
    const { runtime } = buildPgConnectorStack({
      pool: tt.pool,
      lockPool,
      redis: tt.deps.redis,
      redisPrefix: tt.deps.redisKeyPrefix,
      keys: tt.deps.env.encryption,
      registry: tt.deps.connectors!.registry,
      appSecrets: new Map(),
      redirectUri: () => 'https://app.test/cb',
      log: tt.deps.log,
      workerId: 'tth',
      sync: new PgSyncRecorder(tt.pool, { coalesceMs: 0 }),
      fetch: fake.fetch,
    });
    try {
      fake.revokeScope(revoked.businessId, 'businessVideoList');
      const revokedClient = await runtime.connect(revokedScope);
      await expect(revokedClient.listSources(null)).rejects.toMatchObject({
        code: 'scope_missing',
      });

      fake.outage('marketing', true);
      const ads = await runtime.connect(adsScope);
      const window = {
        since: new Date(Date.now() - 86_400_000),
        until: new Date(),
        page: 1,
        pageSize: 50,
      };
      for (let i = 0; i < 3; i++)
        await expect(ads.listConnectionComments(window)).rejects.toMatchObject({
          kind: 'transient',
        });
      const organic = await runtime.connect(healthyScope);
      await expect(organic.listSources(null)).resolves.toMatchObject({ items: [] });
    } finally {
      fake.outage('marketing', false);
      await lockPool.end();
    }

    const r = await tt.req('GET', healthUrl(org.orgId, org.brandId), { cookie: org.owner.cookie });
    expect(r.status).toBe(200);
    const by = new Map(
      (r.body.connections as { connectionId: string }[]).map((c) => [c.connectionId, c]),
    );
    expect(by.get(revokedScope.connectionId)).toMatchObject({
      platform: 'tiktok',
      status: 'needs_reconnection',
      reason: 'oauth_scope_missing',
      missingScopes: ['video.list'],
    });
    expect(by.get(adsScope.connectionId)).toMatchObject({
      platform: 'tiktok_ads',
      status: 'degraded',
      reason: 'recent_failures',
      missingScopes: [],
    });
    expect(by.get(healthyScope.connectionId)).toMatchObject({
      platform: 'tiktok',
      status: 'healthy',
      reason: 'ok',
      missingScopes: [],
    });
  });

  it('only scope names of the allowed shape are returned', async () => {
    const { scope } = await tt.seedConnection(org, {
      platform: 'tiktok',
      externalAccountId: 'odd-scopes',
    });
    await tt.pool.query(
      `UPDATE connection SET status = 'reconnect_required', status_reason = 'oauth_scope_missing',
              missing_scopes = ARRAY['comment.list', '<script>', 'UPPER', $2] WHERE id = $1`,
      [scope.connectionId, 'x'.repeat(65)],
    );
    const r = await tt.req('GET', healthUrl(org.orgId, org.brandId), { cookie: org.owner.cookie });
    const mine = (r.body.connections as { connectionId: string }[]).find(
      (c) => c.connectionId === scope.connectionId,
    );
    expect(mine).toMatchObject({ missingScopes: ['comment.list'] });
    expect(JSON.stringify(r.body)).not.toContain('<script>');
  });
});
