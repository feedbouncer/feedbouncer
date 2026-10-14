import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant, type Tenant } from '../testing/index.js';

let pool: pg.Client;
let close: () => Promise<void>;
let a: Tenant;
let b: Tenant;
beforeAll(async () => {
  ({ c: pool, close } = await migratedDb());
  a = await seedTenant(pool, 'adsa');
  b = await seedTenant(pool, 'adsb');
});
afterAll(() => close());
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; constraint?: string }) => e.constraint ?? e.code,
  );
let n = 0;
const uniq = () => `${Date.now()}${++n}`;
const conn = async (t: Tenant, platform: string, acct = uniq()) =>
  (
    await pool.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
   VALUES ($1,$2,$3,$4,'active') RETURNING id`,
      [t.organizationId, t.brandId, platform, acct],
    )
  ).rows[0]!.id;
const src = async (t: Tenant, connectionId: string, ext: string) =>
  (
    await pool.query<{ id: string }>(
      `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
   VALUES ($1,$2,$3,'ad_post',$4) RETURNING id`,
      [t.organizationId, t.brandId, connectionId, ext],
    )
  ).rows[0]!.id;
const ad = (
  t: Tenant,
  adsConn: string,
  ext: string,
  o: { active?: boolean; inactiveSince?: Date | null } = {},
) =>
  pool.query<{ id: string }>(
    `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id, ad_account_external_id,
     effective_status, active, inactive_since, facebook_resolution, instagram_resolution, last_discovered_at)
   VALUES ($1,$2,$3,$4,'1001',$5,$6,$7,'linked','not_instagram',now()) RETURNING id`,
    [
      t.organizationId,
      t.brandId,
      adsConn,
      ext,
      o.active === false ? 'PAUSED' : 'ACTIVE',
      o.active ?? true,
      o.inactiveSince ?? null,
    ],
  );
const comment = (t: Tenant, c: string, s: string, ext: string, adSourceId: string | null = null) =>
  pool.query(
    `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body, posted_at, ad_source_id)
   VALUES ($1,$2,$3,$4,$5,'x',now(),$6)`,
    [t.organizationId, t.brandId, c, s, ext, adSourceId],
  );

describe('meta ads schema', () => {
  it('accepts meta_ads in the connection platform check', async () => {
    expect(await code(conn(a, 'meta_ads'))).not.toMatch(/check/);
  });

  it('comment identity is per connection, across sources', async () => {
    const c = await conn(a, 'facebook');
    const s1 = await src(a, c, '900_1');
    const s2 = await src(a, c, '900_2');
    await comment(a, c, s1, '900_1_77');
    expect(await code(comment(a, c, s2, '900_1_77'))).toBe('comment_connection_id_external_id_key');
  });

  it('comment.ad_source_id must reference a source of the same tenant and is nulled when that source goes', async () => {
    const c = await conn(a, 'instagram');
    const s1 = await src(a, c, '17900000000000001');
    const s2 = await src(a, c, '17900000000000002');
    await comment(a, c, s1, '17800000000000001', s2);
    const cb = await conn(b, 'instagram');
    const sb = await src(b, cb, '17900000000000003');
    expect(await code(comment(a, c, s1, '17800000000000002', sb))).toMatch(/fkey/);
    await pool.query(`DELETE FROM source WHERE id = $1`, [s2]);
    expect(
      (await pool.query(`SELECT ad_source_id FROM comment WHERE external_id = '17800000000000001'`))
        .rows[0].ad_source_id,
    ).toBeNull();
  });

  it('meta_ad: unique per ads connection, inactive needs inactive_since, ids are digits', async () => {
    const m = await conn(a, 'meta_ads');
    await ad(a, m, '5001');
    expect(await code(ad(a, m, '5001'))).toBe('meta_ad_ads_connection_id_external_id_key');
    expect(await code(ad(a, m, '5002', { active: false, inactiveSince: null }))).toBe(
      'meta_ad_inactive_since_check',
    );
    expect(await code(ad(a, m, 'act_5003'))).toBe('meta_ad_external_id_check');
  });

  it('meta_ad_source rejects a link across tenants', async () => {
    const m = await conn(a, 'meta_ads');
    const adId = (await ad(a, m, '6001')).rows[0]!.id;
    const fbB = await conn(b, 'facebook');
    const sB = await src(b, fbB, '901_1');
    expect(
      await code(
        pool.query(
          `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform) VALUES ($1,$2,$3,$4,'facebook')`,
          [a.organizationId, a.brandId, adId, sB],
        ),
      ),
    ).toMatch(/fkey/);
  });

  it('source_poll is one row per source and cascades with it', async () => {
    const c = await conn(a, 'instagram');
    const s = await src(a, c, '17900000000000009');
    const ins = () =>
      pool.query(
        `INSERT INTO source_poll (source_id, organization_id, brand_id, connection_id) VALUES ($1,$2,$3,$4)`,
        [s, a.organizationId, a.brandId, c],
      );
    await ins();
    expect(await code(ins())).toBe('source_poll_pkey');
    await pool.query(`DELETE FROM source WHERE id = $1`, [s]);
    expect((await pool.query(`SELECT 1 FROM source_poll WHERE source_id = $1`, [s])).rowCount).toBe(
      0,
    );
  });

  it('source_poll rejects a connection that is not the source connection', async () => {
    const c1 = await conn(a, 'instagram');
    const c2 = await conn(a, 'instagram');
    const s = await src(a, c1, '17900000000000010');
    try {
      await pool.query(
        `INSERT INTO source_poll (source_id, organization_id, brand_id, connection_id) VALUES ($1,$2,$3,$4)`,
        [s, a.organizationId, a.brandId, c2],
      );
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe('23503');
    }
  });
});
