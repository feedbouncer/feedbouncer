import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { orgWithRoles, startTestApi, type OrgFixture, type TestApi } from '../testing/harness.js';

let api: TestApi;
let A: OrgFixture;
let B: OrgFixture;
let adsConnectionA: string;
let adsConnectionB: string;

const adsUrl = (f: OrgFixture, query = '') =>
  `/api/v1/orgs/${f.orgId}/brands/${f.brandId}/ads${query}`;

async function connection(f: OrgFixture, platform: string, ext: string): Promise<string> {
  const { rows } = await api.pool.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [f.orgId, f.brandId, platform, ext],
  );
  return rows[0]!.id;
}

async function addAd(
  f: OrgFixture,
  connectionId: string,
  o: {
    id: string;
    account?: string;
    discoveredAt: string;
    fb?: string | null;
    fbResolution?: string;
    igResolution?: string;
  },
): Promise<string> {
  const { rows } = await api.pool.query<{ id: string }>(
    `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id,
                          ad_account_external_id, effective_status, active,
                          facebook_source_external_id, facebook_resolution, instagram_resolution,
                          first_discovered_at, last_discovered_at)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', true, $6, $7, $8, $9, $9) RETURNING id`,
    [
      f.orgId,
      f.brandId,
      connectionId,
      o.id,
      o.account ?? '1001',
      o.fb ?? null,
      o.fbResolution ?? (o.fb ? 'linked' : 'no_post'),
      o.igResolution ?? 'not_instagram',
      o.discoveredAt,
    ],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  const facebook = {
    appId: '1112223334',
    appSecret: new Secret('fb-app-secret-0123456789abcdef'),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('verify-token-0123456789'),
  };
  api = await startTestApi({
    facebook,
    metaAds: { meta: facebook, activeStatuses: ['ACTIVE'] },
  });
  A = await orgWithRoles(api, 'adsa');
  B = await orgWithRoles(api, 'adsb');
  adsConnectionA = await connection(A, 'meta_ads', '1001');
  // Same ad account id in another organization.
  adsConnectionB = await connection(B, 'meta_ads', '1001');
});
afterAll(() => api.close());

describe('ads endpoint', () => {
  it('lists tracked ads with resolutions and hints', async () => {
    const fbConnection = await connection(A, 'facebook', '900');
    const source = await api.pool.query<{ id: string }>(
      `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
       VALUES ($1, $2, $3, 'ad_post', '900_1') RETURNING id`,
      [A.orgId, A.brandId, fbConnection],
    );
    const ad = await addAd(A, adsConnectionA, {
      id: '5001',
      fb: '900_1',
      discoveredAt: '2026-10-14T12:00:00Z',
    });
    await addAd(A, adsConnectionA, {
      id: '5002',
      fbResolution: 'page_not_connected',
      igResolution: 'instagram_account_not_connected',
      discoveredAt: '2026-10-14T11:00:00Z',
    });
    await api.pool.query(
      `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform)
       VALUES ($1, $2, $3, $4, 'facebook')`,
      [A.orgId, A.brandId, ad, source.rows[0]!.id],
    );
    await api.pool.query(
      `INSERT INTO source_poll (source_id, organization_id, brand_id, connection_id,
                                last_polled_at, unavailable_since, last_error_code)
       VALUES ($1, $2, $3, $4, '2026-10-14T12:05:00Z', '2026-10-14T12:05:00Z', 'source_missing')`,
      [source.rows[0]!.id, A.orgId, A.brandId, fbConnection],
    );

    const r = await api.req('GET', adsUrl(A), { cookie: A.owner.cookie });
    expect(r.status).toBe(200);
    expect(r.body.ads.map((x: { adId: string }) => x.adId)).toEqual(['5001', '5002']);
    expect(r.body.ads[0]).toMatchObject({
      adAccountId: '1001',
      active: true,
      facebook: { resolution: 'linked', postId: '900_1' },
      instagram: { resolution: 'not_instagram', mediaId: null },
      lastPolledAt: '2026-10-14T12:05:00.000Z',
      postUnavailable: true,
    });
    expect(r.body.ads[1]).toMatchObject({ lastPolledAt: null, postUnavailable: false });
    expect(r.body.hints).toEqual({ pagesNotConnected: 1, instagramNotConnected: 1 });
    expect(r.body.nextCursor).toBeNull();
  });

  it('paginates with an opaque cursor; a tampered cursor is 400', async () => {
    for (let i = 0; i < 3; i++)
      await addAd(A, adsConnectionA, {
        id: `60${i}`,
        discoveredAt: `2026-10-13T0${i}:00:00Z`,
      });
    const first = await api.req('GET', adsUrl(A, '?limit=2'), { cookie: A.owner.cookie });
    expect(first.body.ads).toHaveLength(2);
    expect(typeof first.body.nextCursor).toBe('string');
    const second = await api.req(
      'GET',
      adsUrl(A, `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`),
      { cookie: A.owner.cookie },
    );
    expect(second.status).toBe(200);
    const seen = [...first.body.ads, ...second.body.ads].map((x: { adId: string }) => x.adId);
    expect(new Set(seen).size).toBe(seen.length);
    const bad = await api.req('GET', adsUrl(A, '?cursor=bm90LWpzb24'), { cookie: A.owner.cookie });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_cursor');
  });

  it("org B cannot read org A's ads (404) even with a shared ad account", async () => {
    await addAd(B, adsConnectionB, { id: '7001', discoveredAt: '2026-10-14T10:00:00Z' });
    const own = await api.req('GET', adsUrl(B), { cookie: B.owner.cookie });
    expect(own.body.ads.map((x: { adId: string }) => x.adId)).toEqual(['7001']);
    const cross = await api.req('GET', adsUrl({ ...A, orgId: A.orgId, brandId: A.brandId }), {
      cookie: B.owner.cookie,
    });
    expect(cross.status).toBe(404);
    const crossBrand = await api.req('GET', adsUrl({ ...B, brandId: A.brandId }), {
      cookie: B.owner.cookie,
    });
    expect(crossBrand.status).toBe(404);
  });

  it('filters by connectionId and rejects unknown query parameters', async () => {
    const other = await connection(A, 'meta_ads', '2002');
    await addAd(A, other, { id: '8001', account: '2002', discoveredAt: '2026-10-14T09:00:00Z' });
    const r = await api.req('GET', adsUrl(A, `?connectionId=${other}`), { cookie: A.owner.cookie });
    expect(r.body.ads.map((x: { adId: string }) => x.adId)).toEqual(['8001']);
    const unknown = await api.req('GET', adsUrl(A, `?x=${randomUUID()}`), {
      cookie: A.owner.cookie,
    });
    expect(unknown.status).toBe(400);
  });

  it('member without the capability gets 403', async () => {
    const r = await api.req('GET', adsUrl(A), { cookie: A.member.cookie });
    expect(r.status).toBe(403);
  });

  it('requires a session', async () => {
    expect((await api.req('GET', adsUrl(A))).status).toBe(401);
  });
});
