import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '@feedbouncer/db';
import { migratedDb, seedTenant, type Tenant } from '@feedbouncer/db/testing';
import type { NormalizedComment } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { PgCommentStore } from '../store.js';
import { PgAdTracking, type BrandMetaConnections, type DiscoveredAdRow } from './tracking.js';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let pool: pg.Pool;
let store: PgCommentStore;
let tracking: PgAdTracking;
let a: Tenant;
let b: Tenant;
let fbA: ConnectionScope;
let igA: ConnectionScope;
let adsA: ConnectionScope;
let adsB: ConnectionScope;

const connect = async (x: Tenant, platform: string, ext: string): Promise<ConnectionScope> => {
  const r = await ctx.c.query<{ id: string }>(
    `INSERT INTO connection (organization_id, brand_id, platform, external_account_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [x.organizationId, x.brandId, platform, ext],
  );
  return { organizationId: x.organizationId, brandId: x.brandId, connectionId: r.rows[0]!.id };
};

beforeAll(async () => {
  ctx = await migratedDb();
  pool = createPool(ctx.db.url, { applicationName: 'ad-tracking-test', onIdleError: () => {} });
  store = new PgCommentStore(pool);
  tracking = new PgAdTracking(pool, store);
  a = await seedTenant(ctx.c, 'ads-a');
  b = await seedTenant(ctx.c, 'ads-b');
  // Only the connections below: tenant B has no Page or Instagram connection.
  await ctx.c.query('DELETE FROM connection WHERE id = ANY($1::uuid[])', [
    [a.connectionId, b.connectionId],
  ]);
  fbA = await connect(a, 'facebook', '900');
  igA = await connect(a, 'instagram', '17841400000000001');
  adsA = await connect(a, 'meta_ads', '1001');
  adsB = await connect(b, 'meta_ads', '1001');
});
afterAll(async () => {
  await pool.end();
  await ctx.close();
});
beforeEach(async () => {
  // Sources cascade to their comments, links and poll rows.
  for (const x of [a, b]) {
    await ctx.c.query('DELETE FROM source WHERE organization_id = $1 AND brand_id = $2', [
      x.organizationId,
      x.brandId,
    ]);
    await ctx.c.query('DELETE FROM meta_ad WHERE organization_id = $1 AND brand_id = $2', [
      x.organizationId,
      x.brandId,
    ]);
    await ctx.c.query(
      `UPDATE connection SET status = 'active' WHERE organization_id = $1 AND brand_id = $2`,
      [x.organizationId, x.brandId],
    );
  }
});

const at = new Date(Date.UTC(2026, 9, 14, 12));
const days = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

function adRow(
  id: string,
  p: { fb?: string; ig?: string; active?: boolean },
  conns: BrandMetaConnections,
): DiscoveredAdRow {
  const page = conns.facebook.get('900') ?? null;
  const ig = conns.instagram.get('17841400000000001') ?? null;
  const active = p.active ?? true;
  return {
    externalId: id,
    adAccountExternalId: '1001',
    effectiveStatus: active ? 'ACTIVE' : 'PAUSED',
    active,
    facebook:
      p.fb === undefined
        ? { sourceExternalId: null, resolution: 'no_post', connection: null }
        : page
          ? { sourceExternalId: p.fb, resolution: 'linked', connection: page }
          : { sourceExternalId: p.fb, resolution: 'page_not_connected', connection: null },
    instagram:
      p.ig === undefined
        ? {
            sourceExternalId: null,
            accountExternalId: null,
            resolution: 'not_instagram',
            connection: null,
          }
        : ig
          ? {
              sourceExternalId: p.ig,
              accountExternalId: '17841400000000001',
              resolution: 'linked',
              connection: ig,
            }
          : {
              sourceExternalId: p.ig,
              accountExternalId: '17841400000000001',
              resolution: 'instagram_account_not_connected',
              connection: null,
            },
  };
}

const sourcesOf = async (s: ConnectionScope) =>
  (
    await pool.query<{ externalId: string; kind: string }>(
      `SELECT external_id AS "externalId", kind FROM source
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 ORDER BY external_id`,
      [s.organizationId, s.brandId, s.connectionId],
    )
  ).rows;
const pollRows = async () =>
  (
    await pool.query('SELECT * FROM source_poll WHERE organization_id = $1 AND brand_id = $2', [
      a.organizationId,
      a.brandId,
    ])
  ).rows;
const linksOf = async (ext: string) =>
  (
    await pool.query<{ external_id: string }>(
      `SELECT ma.external_id FROM meta_ad_source mas
         JOIN source s ON s.id = mas.source_id AND s.organization_id = mas.organization_id
                      AND s.brand_id = mas.brand_id
         JOIN meta_ad ma ON ma.id = mas.ad_id AND ma.organization_id = mas.organization_id
                        AND ma.brand_id = mas.brand_id
        WHERE mas.organization_id = $1 AND mas.brand_id = $2 AND s.external_id = $3
        ORDER BY ma.external_id`,
      [a.organizationId, a.brandId, ext],
    )
  ).rows.map((r) => r.external_id);
const resolutionOf = async (s: ConnectionScope, adExt: string) =>
  (
    await pool.query(
      `SELECT facebook_resolution AS facebook, instagram_resolution AS instagram FROM meta_ad
        WHERE organization_id = $1 AND brand_id = $2 AND ads_connection_id = $3 AND external_id = $4`,
      [s.organizationId, s.brandId, s.connectionId, adExt],
    )
  ).rows[0];
const setStatus = async (s: ConnectionScope, status: string) =>
  pool.query(
    'UPDATE connection SET status = $4 WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
    [s.organizationId, s.brandId, s.connectionId, status],
  );
const comment = (sourceExternalId: string, externalId: string): NormalizedComment => ({
  externalId,
  sourceExternalId,
  parentExternalId: null,
  author: { externalId: 'u1', displayName: 'Ann', profileUrl: null },
  body: 'hi',
  postedAt: at,
  platformState: 'visible',
  permalink: null,
});

describe('PgAdTracking', () => {
  it('records an ad on both placements: one source per platform, one poll row each', async () => {
    const conns = await tracking.brandMetaConnections(adsA);
    await tracking.recordAd(
      adsA,
      adRow('5001', { fb: '900_1', ig: '17900000000000001' }, conns),
      at,
    );
    expect(await sourcesOf(fbA)).toEqual([{ externalId: '900_1', kind: 'ad_post' }]);
    expect(await sourcesOf(igA)).toEqual([{ externalId: '17900000000000001', kind: 'ad_post' }]);
    expect(await pollRows()).toHaveLength(2);
  });
  it('recordAd is idempotent', async () => {
    const conns = await tracking.brandMetaConnections(adsA);
    const row = adRow('5001', { fb: '900_1', ig: '17900000000000001' }, conns);
    await tracking.recordAd(adsA, row, at);
    await tracking.recordAd(adsA, row, at);
    expect(await pollRows()).toHaveLength(2);
    expect(await linksOf('900_1')).toEqual(['5001']);
    expect(await resolutionOf(adsA, '5001')).toEqual({ facebook: 'linked', instagram: 'linked' });
  });
  it('two ads on one post: one source, one poll row, two links', async () => {
    const conns = await tracking.brandMetaConnections(adsA);
    await tracking.recordAd(adsA, adRow('5001', { fb: '900_1' }, conns), at);
    await tracking.recordAd(adsA, adRow('5002', { fb: '900_1' }, conns), at);
    expect(await sourcesOf(fbA)).toHaveLength(1);
    expect(await pollRows()).toHaveLength(1);
    expect(await linksOf('900_1')).toEqual(['5001', '5002']);
  });
  it('shared ad account: tenant B gets page_not_connected and no source under A (Review Focus 3)', async () => {
    const connsB = await tracking.brandMetaConnections(adsB);
    expect(connsB.facebook.size).toBe(0);
    await tracking.recordAd(adsB, adRow('5001', { fb: '900_1' }, connsB), at);
    expect(await resolutionOf(adsB, '5001')).toMatchObject({ facebook: 'page_not_connected' });
    expect(await sourcesOf(fbA)).toHaveLength(0);
  });
  it('recordAd refuses a placement connection from another brand', async () => {
    const row = adRow('5009', { fb: '900_1' }, await tracking.brandMetaConnections(adsA));
    await expect(tracking.recordAd(adsB, row, at)).rejects.toThrow();
    expect(await sourcesOf(fbA)).toHaveLength(0);
    expect(await resolutionOf(adsB, '5009')).toBeUndefined();
  });
  it('recordAd refuses a placement whose connection is not that platform', async () => {
    const conns = await tracking.brandMetaConnections(adsA);
    const row = adRow('5010', { fb: '900_1' }, conns);
    await expect(
      tracking.recordAd(adsA, { ...row, facebook: { ...row.facebook, connection: igA } }, at),
    ).rejects.toThrow();
    await expect(tracking.recordAd(fbA, row, at)).rejects.toThrow();
    expect(await sourcesOf(igA)).toHaveLength(0);
  });
  it('retirement: polled during grace, not after; re-activation resumes (Review Focus 4)', async () => {
    const conns = await tracking.brandMetaConnections(adsA);
    await tracking.recordAd(adsA, adRow('5001', { fb: '900_1' }, conns), at);
    expect(await tracking.retireMissing(adsA, new Set(), at)).toBe(1);
    expect(await tracking.dueSources(fbA, days(at, 6.9), { graceDays: 7, limit: 10 })).toHaveLength(
      1,
    );
    expect(await tracking.dueSources(fbA, days(at, 7.1), { graceDays: 7, limit: 10 })).toHaveLength(
      0,
    );
    await tracking.recordAd(adsA, adRow('5001', { fb: '900_1' }, conns), days(at, 8));
    expect(await tracking.dueSources(fbA, days(at, 8), { graceDays: 7, limit: 10 })).toHaveLength(
      1,
    );
  });
  it('retireMissing keeps seen ads and only touches its own connection', async () => {
    const conns = await tracking.brandMetaConnections(adsA);
    await tracking.recordAd(adsA, adRow('5001', { fb: '900_1' }, conns), at);
    await tracking.recordAd(adsA, adRow('5002', { fb: '900_2' }, conns), at);
    await tracking.recordAd(adsB, adRow('5003', {}, await tracking.brandMetaConnections(adsB)), at);
    expect(await tracking.retireMissing(adsA, new Set(['5001']), at)).toBe(1);
    expect(await tracking.retireMissing(adsA, new Set(['5001']), at)).toBe(0);
    expect(await tracking.retireMissing(adsB, new Set(), at)).toBe(1);
  });
  it('revoking the ads connection or the page connection stops polling', async () => {
    await tracking.recordAd(
      adsA,
      adRow('5001', { fb: '900_1' }, await tracking.brandMetaConnections(adsA)),
      at,
    );
    expect(await tracking.connectionsWithDueSources(at, { graceDays: 7, limit: 10 })).toEqual([
      { scope: fbA, platform: 'facebook' },
    ]);
    await setStatus(adsA, 'reconnect_required');
    expect(await tracking.dueSources(fbA, at, { graceDays: 7, limit: 10 })).toHaveLength(0);
    await setStatus(adsA, 'active');
    await setStatus(fbA, 'revoked');
    expect(await tracking.connectionsWithDueSources(at, { graceDays: 7, limit: 10 })).toHaveLength(
      0,
    );
  });
  it('dueSources is scoped to its tenant', async () => {
    await tracking.recordAd(
      adsA,
      adRow('5001', { fb: '900_1' }, await tracking.brandMetaConnections(adsA)),
      at,
    );
    const forged = { ...fbA, organizationId: b.organizationId, brandId: b.brandId };
    expect(await tracking.dueSources(forged, at, { graceDays: 7, limit: 10 })).toHaveLength(0);
  });
  it('orders due sources by recent comment activity, never-polled first', async () => {
    const conns = await tracking.brandMetaConnections(adsA);
    for (const [ad, post] of [
      ['5001', '900_1'],
      ['5002', '900_2'],
      ['5003', '900_3'],
    ] as const)
      await tracking.recordAd(adsA, adRow(ad, { fb: post }, conns), at);
    const due = await tracking.dueSources(fbA, at, { graceDays: 7, limit: 10 });
    const id = (ext: string) => due.find((s) => s.sourceExternalId === ext)!.sourceId;
    const done = (lastCommentAt: Date) =>
      ({
        kind: 'done',
        highWaterAt: lastCommentAt,
        lastCommentAt,
        fullScan: false,
        at,
        nextPollAt: at,
      }) as const;
    await tracking.savePollProgress(fbA, id('900_1'), done(days(at, -1)));
    await tracking.savePollProgress(fbA, id('900_2'), done(days(at, -1 / 24)));
    expect(
      (await tracking.dueSources(fbA, at, { graceDays: 7, limit: 10 })).map(
        (s) => s.sourceExternalId,
      ),
    ).toEqual(['900_3', '900_2', '900_1']);
    expect(
      (await tracking.dueSources(fbA, at, { graceDays: 7, limit: 2 })).map(
        (s) => s.sourceExternalId,
      ),
    ).toEqual(['900_3', '900_2']);
  });
  it('savePollProgress: resume keeps the source due, done clears the cursor', async () => {
    await tracking.recordAd(
      adsA,
      adRow('5001', { fb: '900_1' }, await tracking.brandMetaConnections(adsA)),
      at,
    );
    const [s] = await tracking.dueSources(fbA, at, { graceDays: 7, limit: 10 });
    await tracking.savePollProgress(fbA, s!.sourceId, {
      kind: 'resume',
      cursor: 'abc',
      boundary: days(at, -2),
      at,
    });
    expect(await tracking.dueSources(fbA, at, { graceDays: 7, limit: 10 })).toEqual([
      expect.objectContaining({
        resumeCursor: 'abc',
        resumeBoundary: days(at, -2),
        highWaterAt: null,
      }),
    ]);
    const hw = days(at, -1);
    await tracking.savePollProgress(fbA, s!.sourceId, {
      kind: 'done',
      highWaterAt: hw,
      lastCommentAt: hw,
      fullScan: true,
      at,
      nextPollAt: at,
    });
    await tracking.savePollProgress(fbA, s!.sourceId, {
      kind: 'done',
      highWaterAt: days(at, -3),
      lastCommentAt: null,
      fullScan: false,
      at,
      nextPollAt: at,
    });
    expect(await tracking.dueSources(fbA, at, { graceDays: 7, limit: 10 })).toEqual([
      {
        sourceId: s!.sourceId,
        sourceExternalId: '900_1',
        highWaterAt: hw,
        resumeCursor: null,
        resumeBoundary: null,
        lastFullScanAt: at,
      },
    ]);
    // another tenant's scope writes nothing
    await tracking.savePollProgress(
      { ...fbA, organizationId: b.organizationId, brandId: b.brandId },
      s!.sourceId,
      {
        kind: 'resume',
        cursor: 'evil',
        boundary: null,
        at,
      },
    );
    expect(
      (await tracking.dueSources(fbA, at, { graceDays: 7, limit: 10 }))[0]!.resumeCursor,
    ).toBeNull();
  });
  it('unavailable sources wait for retryAt', async () => {
    await tracking.recordAd(
      adsA,
      adRow('5001', { fb: '900_1' }, await tracking.brandMetaConnections(adsA)),
      at,
    );
    const [s] = await tracking.dueSources(fbA, at, { graceDays: 7, limit: 10 });
    await tracking.savePollProgress(fbA, s!.sourceId, {
      kind: 'unavailable',
      code: 'source_missing',
      at,
      retryAt: days(at, 0.25),
    });
    expect(await tracking.dueSources(fbA, days(at, 0.2), { graceDays: 7, limit: 10 })).toHaveLength(
      0,
    );
    expect(await tracking.dueSources(fbA, days(at, 0.3), { graceDays: 7, limit: 10 })).toHaveLength(
      1,
    );
  });
  it('a changed creative moves the link to the new post', async () => {
    const conns = await tracking.brandMetaConnections(adsA);
    await tracking.recordAd(adsA, adRow('5001', { fb: '900_1' }, conns), at);
    await tracking.recordAd(adsA, adRow('5001', { fb: '900_2' }, conns), at);
    expect(await linksOf('900_1')).toEqual([]);
    expect(await linksOf('900_2')).toEqual(['5001']);
  });
  it('list(): origin and ads are derived per tenant', async () => {
    await tracking.recordAd(
      adsA,
      adRow('5001', { fb: '900_1' }, await tracking.brandMetaConnections(adsA)),
      at,
    );
    const ad = await store.upsertFromPlatform(fbA, comment('900_1', '900_1_1'), {
      ownAccountExternalId: '900',
      syncedAt: at,
    });
    const organic = await store.upsertFromPlatform(fbA, comment('900_9', '900_9_1'), {
      ownAccountExternalId: '900',
      syncedAt: at,
    });
    const rows = await store.list(a, { before: null, limit: 50 });
    expect(rows.find((r) => r.id === ad.commentId)).toMatchObject({
      origin: 'ad',
      ads: [{ adId: '5001', adAccountId: '1001' }],
    });
    expect(rows.find((r) => r.id === organic.commentId)).toMatchObject({
      origin: 'organic',
      ads: [],
    });
    expect(
      (await store.list(a, { before: null, limit: 50, origin: 'ad' })).map((r) => r.id),
    ).toEqual([ad.commentId]);
    expect(
      (await store.list(a, { before: null, limit: 50, origin: 'organic' })).map((r) => r.id),
    ).toEqual([organic.commentId]);
    expect(await store.list(b, { before: null, limit: 50 })).toEqual([]);
    expect(await store.list(b, { before: null, limit: 50, origin: 'ad' })).toEqual([]);
  });
  it('list(): a comment seen through an ad source is an ad comment with that ad', async () => {
    await tracking.recordAd(
      adsA,
      adRow('5001', { ig: '17900000000000001' }, await tracking.brandMetaConnections(adsA)),
      at,
    );
    const [s] = await tracking.dueSources(igA, at, { graceDays: 7, limit: 10 });
    const r = await store.upsertFromPlatform(
      igA,
      comment('17900000000000099', '18000000000000001'),
      {
        ownAccountExternalId: '17841400000000001',
        syncedAt: at,
      },
    );
    expect((await store.load(a, r.commentId))?.origin).toBe('organic');
    await store.markSeenViaAdSource(igA, r.commentId, s!.sourceId);
    expect(await store.load(a, r.commentId)).toMatchObject({
      origin: 'ad',
      ads: [{ adId: '5001', adAccountId: '1001' }],
    });
  });
});
