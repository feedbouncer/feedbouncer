import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';
import { adminUrl, createScratchDatabase } from '../testing/scratch-db.js';
import { runPrisma } from '../testing/prisma-cli.js';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { listMigrationDirs, rollbackLatest } from '../migrations/rollback.js';
import { snapshotSchema } from '../testing/schema-snapshot.js';

const MIGRATION = '20261016000700_comments_list';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
});
afterAll(() => ctx.close());

let n = 0;
async function seedAd(label: string) {
  const t = await seedTenant(c, label);
  const adsConnection = (
    await c.query<{ id: string }>(
      `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, status)
       VALUES ($1, $2, 'meta_ads', $3, 'active') RETURNING id`,
      [t.organizationId, t.brandId, `act-${label}`],
    )
  ).rows[0]!.id;
  const insertAd = async (name: string | null) =>
    c.query<{ id: string }>(
      `INSERT INTO meta_ad (organization_id, brand_id, ads_connection_id, external_id, ad_account_external_id,
         effective_status, active, facebook_resolution, instagram_resolution, last_discovered_at, name)
       VALUES ($1, $2, $3, $4, '1001', 'ACTIVE', true, 'linked', 'not_instagram', now(), $5) RETURNING id`,
      [t.organizationId, t.brandId, adsConnection, String(7000 + ++n), name],
    );
  return { t, insertAd };
}

describe('meta_ad name', () => {
  it("accepts null and 200 code points of emoji; rejects '' and 201 chars", async () => {
    const { insertAd } = await seedAd('ad-name');
    await insertAd(null);
    await insertAd('😀'.repeat(200));
    for (const bad of ['', 'a'.repeat(201)])
      await expectPgError(insertAd(bad), '23514', 'meta_ad_name_check');
  });
});

describe('new columns', () => {
  it('existing meta_ad rows have null name, deleted_at and status_checked_at; meta_ad_source.unlinked_at null', async () => {
    const { t, insertAd } = await seedAd('ad-null');
    const adId = (await insertAd(null)).rows[0]!.id;
    const ad = (
      await c.query('SELECT name, deleted_at, status_checked_at FROM meta_ad WHERE id = $1', [adId])
    ).rows[0];
    expect(ad).toEqual({ name: null, deleted_at: null, status_checked_at: null });
    await c.query(
      `INSERT INTO meta_ad_source (organization_id, brand_id, ad_id, source_id, platform)
       VALUES ($1, $2, $3, $4, 'facebook')`,
      [t.organizationId, t.brandId, adId, t.sourceId],
    );
    const link = (await c.query('SELECT unlinked_at FROM meta_ad_source WHERE ad_id = $1', [adId]))
      .rows[0];
    expect(link).toEqual({ unlinked_at: null });
  });
});

describe('visible comment index', () => {
  it('is partial', async () => {
    const r = await c.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'comment_visible_organization_id_posted_at_idx'",
    );
    expect(r.rows).toHaveLength(1);
    const def = r.rows[0]!.indexdef;
    expect(def).toContain('(organization_id, posted_at DESC, id DESC)');
    expect(def).toContain("WHERE ((platform_state = 'visible'::text) AND (NOT is_own_account))");
  });
});

describe('down.sql', () => {
  it('reverts cleanly and re-applies', async () => {
    const db = await createScratchDatabase(adminUrl());
    try {
      expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
      const k = await db.client();
      try {
        const applied = await snapshotSchema(k);
        const dirs = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
        // Migrations added after this one are rolled back first.
        for (const later of dirs.slice(dirs.indexOf(MIGRATION) + 1).reverse())
          expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
            status: 'rolled_back',
            migration: later,
          });
        expect(await rollbackLatest(k, DEFAULT_MIGRATIONS_DIR)).toEqual({
          status: 'rolled_back',
          migration: MIGRATION,
        });
        const down = (await snapshotSchema(k)).join('\n');
        expect(down).not.toContain('status_checked_at');
        expect(down).not.toContain('unlinked_at');
        expect(down).not.toContain('meta_ad_name_check');
        expect(down).not.toContain('comment_visible_organization_id_posted_at_idx');
        expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
        expect(await snapshotSchema(k)).toEqual(applied);
      } finally {
        await k.end();
      }
    } finally {
      await db.drop();
    }
  });
});
