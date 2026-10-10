import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { DEFAULT_MIGRATIONS_DIR } from './cli.js';
import {
  PRISMA_MIGRATE_LOCK_ID,
  RollbackError,
  listMigrationDirs,
  rollbackLatest,
} from './rollback.js';
import { adminUrl, createScratchDatabase, type ScratchDb } from '../testing/scratch-db.js';
import { runPrisma } from '../testing/prisma-cli.js';
import { makeMigrationsDir } from '../testing/migration-fixtures.js';
import { snapshotSchema } from '../testing/schema-snapshot.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function scratch(opts?: Parameters<typeof createScratchDatabase>[1]): Promise<ScratchDb> {
  const db = await createScratchDatabase(adminUrl(), opts);
  cleanups.push(db.drop);
  return db;
}
async function withClient<T>(db: ScratchDb, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await db.client();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const appliedNames = (c: pg.ClientBase) =>
  c
    .query<{
      migration_name: string;
    }>('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1')
    .then((r) => r.rows.map((x) => x.migration_name));

describe('migration workflow', () => {
  it('applies every migration to an empty database, and a second run is a no-op', async () => {
    const db = await scratch();
    const all = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
    expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
    const first = await withClient(db, async (c) => ({
      s: await snapshotSchema(c),
      n: await appliedNames(c),
    }));
    expect(first.n).toEqual(all);
    const again = await runPrisma(['migrate', 'deploy'], db.url);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/No pending migrations/i);
    await withClient(db, async (c) => {
      expect(await snapshotSchema(c)).toEqual(first.s);
      expect(await appliedNames(c)).toEqual(all);
    });
  });

  it('two concurrent deploys apply each migration exactly once and both exit 0', async () => {
    const db = await scratch();
    const [a, b] = await Promise.all([
      runPrisma(['migrate', 'deploy'], db.url),
      runPrisma(['migrate', 'deploy'], db.url),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);
    await withClient(db, async (c) => {
      const { rows } = await c.query(
        'SELECT migration_name, count(*)::int AS n FROM _prisma_migrations GROUP BY 1 HAVING count(*) > 1',
      );
      expect(rows).toEqual([]);
      expect(await appliedNames(c)).toEqual(await listMigrationDirs(DEFAULT_MIGRATIONS_DIR));
    });
  });

  it('deploy waits while the shared advisory lock is held (rollback and deploy cannot interleave)', async () => {
    const db = await scratch();
    const holder = await db.client();
    cleanups.push(() => holder.end());
    await holder.query('SELECT pg_advisory_lock($1)', [PRISMA_MIGRATE_LOCK_ID]);
    let done = false;
    const deploy = runPrisma(['migrate', 'deploy'], db.url).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 3_000));
    expect(done, 'Prisma no longer uses lock key 72707369; update PRISMA_MIGRATE_LOCK_ID').toBe(
      false,
    );
    await holder.query('SELECT pg_advisory_unlock($1)', [PRISMA_MIGRATE_LOCK_ID]);
    expect((await deploy).code).toBe(0);
  });

  it('a failing migration leaves the schema exactly as before and blocks rollback until resolved', async () => {
    const db = await scratch();
    const all = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
    expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
    const before = await withClient(db, snapshotSchema);
    const broken = '29991231235959_broken_fixture';
    const fx = await makeMigrationsDir(all, {
      name: broken,
      sql: 'BEGIN;\nCREATE TABLE should_not_survive (id int);\nALTER TABLE organization ADD COLUMN should_not_survive int;\nSELECT 1/0;\nCOMMIT;\n',
    });
    cleanups.push(fx.cleanup);
    const res = await runPrisma(['migrate', 'deploy'], db.url, { migrationsDir: fx.relDir });
    expect(res.code).not.toBe(0);
    await withClient(db, async (c) => {
      expect(await snapshotSchema(c)).toEqual(before);
      const { rows } = await c.query(
        'SELECT finished_at FROM _prisma_migrations WHERE migration_name = $1',
        [broken],
      );
      expect(rows).toEqual([{ finished_at: null }]);
      await expect(rollbackLatest(c, fx.absDir)).rejects.toBeInstanceOf(RollbackError);
    });
    expect(
      (
        await runPrisma(['migrate', 'resolve', '--rolled-back', broken], db.url, {
          migrationsDir: fx.relDir,
        })
      ).code,
    ).toBe(0);
    await withClient(db, async (c) => {
      expect(await rollbackLatest(c, fx.absDir)).toEqual({
        status: 'rolled_back',
        migration: all.at(-1),
      });
    });
  });

  it('every migration reverses exactly: rolling back k steps equals applying only the first n-k', async () => {
    const all = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
    const forward: string[][] = [];
    for (let k = 0; k <= all.length; k++) {
      const db = await scratch();
      const fx = await makeMigrationsDir(all.slice(0, k));
      cleanups.push(fx.cleanup);
      if (k > 0)
        expect(
          (await runPrisma(['migrate', 'deploy'], db.url, { migrationsDir: fx.relDir })).code,
        ).toBe(0);
      forward.push(await withClient(db, snapshotSchema));
    }
    const db = await scratch();
    expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
    await withClient(db, async (c) => {
      expect(await snapshotSchema(c)).toEqual(forward[all.length]);
      for (let k = all.length; k > 0; k--) {
        expect(await rollbackLatest(c, DEFAULT_MIGRATIONS_DIR)).toEqual({
          status: 'rolled_back',
          migration: all[k - 1],
        });
        expect(await snapshotSchema(c), `after reverting ${all[k - 1]}`).toEqual(forward[k - 1]);
      }
      expect(await rollbackLatest(c, DEFAULT_MIGRATIONS_DIR)).toEqual({
        status: 'nothing_to_roll_back',
      });
    });
    expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
    expect(await withClient(db, snapshotSchema)).toEqual(forward[all.length]);
  });

  it('rollback refuses a tampered ledger name and changes nothing', async () => {
    const db = await scratch();
    expect((await runPrisma(['migrate', 'deploy'], db.url)).code).toBe(0);
    await withClient(db, async (c) => {
      await c.query(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
         VALUES (gen_random_uuid()::text, 'x', '99999999999999_zz/../../../etc', now(), now(), 1)`,
      );
      const before = await snapshotSchema(c);
      await expect(rollbackLatest(c, DEFAULT_MIGRATIONS_DIR)).rejects.toBeInstanceOf(RollbackError);
      expect(await snapshotSchema(c)).toEqual(before);
    });
  });

  // Enabled in the task that adds the UTF8 guard to the first schema migration.
  it.todo('the first schema migration refuses a non-UTF8 database');
});
