import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { migratedDb, seedTenant } from '../testing/fixtures.js';
import { expectPgError } from '../testing/pg-error.js';
import { adminUrl, createScratchDatabase } from '../testing/scratch-db.js';
import { runPrisma } from '../testing/prisma-cli.js';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { listMigrationDirs, rollbackLatest } from '../migrations/rollback.js';
import { snapshotSchema } from '../testing/schema-snapshot.js';

const MIGRATION = '20261016000600_hidden_today';

let ctx: Awaited<ReturnType<typeof migratedDb>>;
let c: pg.Client;
beforeAll(async () => {
  ctx = await migratedDb();
  c = ctx.c;
});
afterAll(() => ctx.close());

describe('brand timezone', () => {
  it('existing brands default to UTC with timezone_set_at null', async () => {
    const t = await seedTenant(c, 'tz-default');
    const row = (
      await c.query<{ timezone: string; timezone_set_at: Date | null }>(
        'SELECT timezone, timezone_set_at FROM brand WHERE id = $1',
        [t.brandId],
      )
    ).rows[0]!;
    expect(row.timezone).toBe('UTC');
    expect(row.timezone_set_at).toBeNull();
  });

  it('seedTenant with a timezone sets it and timezone_set_at', async () => {
    const t = await seedTenant(c, 'tz-set', { timezone: 'Asia/Tokyo' });
    const row = (
      await c.query<{ timezone: string; set: boolean }>(
        'SELECT timezone, timezone_set_at IS NOT NULL AS set FROM brand WHERE id = $1',
        [t.brandId],
      )
    ).rows[0]!;
    expect(row).toEqual({ timezone: 'Asia/Tokyo', set: true });
  });

  it('brand_timezone_check rejects malformed names and accepts IANA names', async () => {
    const t = await seedTenant(c, 'tz-check');
    const set = (tz: string) =>
      c.query('UPDATE brand SET timezone = $2 WHERE id = $1', [t.brandId, tz]);
    for (const bad of ['../etc/passwd', 'Europe/Berlin; DROP', '', 'A/' + 'b'.repeat(63)])
      await expectPgError(set(bad), '23514', 'brand_timezone_check');
    for (const ok of ['America/Los_Angeles', 'UTC', 'Etc/GMT+5']) await set(ok);
  });

  it('date_trunc with the brand zone gives local midnight', async () => {
    const r = await c.query<{ ok: boolean }>(
      `SELECT date_trunc('day', '2026-10-16T06:55Z'::timestamptz, 'America/Los_Angeles')
              = '2026-10-16T07:00Z'::timestamptz - interval '1 day' AS ok`,
    );
    expect(r.rows[0]!.ok).toBe(true);
  });
});

describe('applied hide index', () => {
  it('exists and is partial', async () => {
    const r = await c.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'moderation_action_applied_hide_idx'",
    );
    expect(r.rows).toHaveLength(1);
    const def = r.rows[0]!.indexdef;
    expect(def).toContain('(organization_id, completed_at DESC, id DESC)');
    expect(def).toContain("WHERE ((kind = 'hide'::text) AND (status = 'applied'::text))");
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
        expect(down).not.toContain('timezone');
        expect(down).not.toContain('moderation_action_applied_hide_idx');
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
