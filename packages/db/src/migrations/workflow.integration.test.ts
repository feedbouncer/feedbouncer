import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
async function deployOk(db: ScratchDb, migrationsDir?: string): Promise<void> {
  const r = await runPrisma(['migrate', 'deploy'], db.url, migrationsDir ? { migrationsDir } : {});
  expect(r.code, r.stderr).toBe(0);
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
    await deployOk(db);
    const first = await withClient(db, async (c) => ({
      s: await snapshotSchema(c),
      n: await appliedNames(c),
    }));
    expect(first.n).toEqual(all);
    const again = await runPrisma(['migrate', 'deploy'], db.url);
    expect(again.code, again.stderr).toBe(0);
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
    expect([a.code, b.code], `${a.stderr}\n${b.stderr}`).toEqual([0, 0]);
    await withClient(db, async (c) => {
      const { rows } = await c.query(
        'SELECT migration_name, count(*)::int AS n FROM _prisma_migrations GROUP BY 1 HAVING count(*) > 1',
      );
      expect(rows).toEqual([]);
      expect(await appliedNames(c)).toEqual(await listMigrationDirs(DEFAULT_MIGRATIONS_DIR));
    });
  });

  it('deploy waits on the shared advisory lock (rollback and deploy cannot interleave)', async () => {
    const db = await scratch();
    const holder = await db.client();
    cleanups.push(() => holder.end());
    await holder.query('SELECT pg_advisory_lock($1)', [PRISMA_MIGRATE_LOCK_ID]);
    const deploy = runPrisma(['migrate', 'deploy'], db.url);
    // Prove the wait positively: a waiter on exactly our key shows up as an ungranted lock.
    // A key that fits in 32 bits is stored as classid 0, objid = key, objsubid 1.
    const deadline = Date.now() + 60_000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      const { rows } = await holder.query(
        `SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = 0 AND objid = $1 AND objsubid = 1`,
        [PRISMA_MIGRATE_LOCK_ID],
      );
      waiting = rows.length > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    expect(
      waiting,
      `no session waits on advisory lock ${PRISMA_MIGRATE_LOCK_ID}; Prisma may use a different key`,
    ).toBe(true);
    await holder.query('SELECT pg_advisory_unlock($1)', [PRISMA_MIGRATE_LOCK_ID]);
    const res = await deploy;
    expect(res.code, res.stderr).toBe(0);
  });

  it('a failing migration leaves no partial DDL behind and blocks rollback until resolved', async () => {
    const db = await scratch();
    const all = await listMigrationDirs(DEFAULT_MIGRATIONS_DIR);
    await deployOk(db);
    const before = await withClient(db, snapshotSchema);
    const broken = '29991231235959_broken_fixture';
    const fx = await makeMigrationsDir(all, {
      name: broken,
      sql: 'BEGIN;\nCREATE TABLE fixture_a (id int);\nALTER TABLE fixture_a ADD COLUMN x int;\nSELECT 1/0;\nCOMMIT;\n',
    });
    cleanups.push(fx.cleanup);
    const res = await runPrisma(['migrate', 'deploy'], db.url, { migrationsDir: fx.relDir });
    expect(res.code).not.toBe(0);
    await withClient(db, async (c) => {
      expect(await snapshotSchema(c)).toEqual(before);
      expect((await snapshotSchema(c)).join('\n')).not.toContain('fixture_a');
      const { rows } = await c.query(
        'SELECT finished_at FROM _prisma_migrations WHERE migration_name = $1',
        [broken],
      );
      expect(rows).toEqual([{ finished_at: null }]);
      const err = await rollbackLatest(c, fx.absDir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RollbackError);
      expect((err as Error).message).toContain(`prisma migrate resolve --rolled-back ${broken}`);
    });
    const resolved = await runPrisma(['migrate', 'resolve', '--rolled-back', broken], db.url, {
      migrationsDir: fx.relDir,
    });
    expect(resolved.code, resolved.stderr).toBe(0);
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
      if (k > 0) await deployOk(db, fx.relDir);
      forward.push(await withClient(db, snapshotSchema));
    }
    const db = await scratch();
    await deployOk(db);
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
    await deployOk(db);
    expect(await withClient(db, snapshotSchema)).toEqual(forward[all.length]);
  });

  it('rollback refuses a tampered ledger name and changes nothing', async () => {
    const db = await scratch();
    await deployOk(db);
    await withClient(db, async (c) => {
      await c.query(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
         VALUES (gen_random_uuid()::text, 'x', '99999999999999_zz/../../../etc', now(), now(), 1)`,
      );
      const ledger = () =>
        c.query(
          'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY 1',
        );
      const before = { schema: await snapshotSchema(c), ledger: (await ledger()).rows };
      const err = await rollbackLatest(c, DEFAULT_MIGRATIONS_DIR).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RollbackError);
      expect((err as Error).message).toMatch(/is not in .*; refusing/);
      expect(await snapshotSchema(c)).toEqual(before.schema);
      expect((await ledger()).rows).toEqual(before.ledger);
    });
  });

  it('the tenancy migration refuses a non-UTF8 database and leaves nothing behind', async () => {
    const db = await scratch({ encoding: 'SQL_ASCII' });
    const r = await runPrisma(['migrate', 'deploy'], db.url);
    expect(r.code).not.toBe(0);
    await withClient(db, async (c) => {
      // The wrapped migration leaves the schema engine's connection in an aborted
      // transaction, which masks the guard's own message in the CLI output, so the
      // refusal is asserted through the ledger and the schema instead.
      expect(await appliedNames(c)).toEqual(['20261010000000_processed_job']);
      const t = await c.query(
        "SELECT to_regclass('organization') AS org, to_regproc('fb_set_updated_at') AS fn",
      );
      expect(t.rows[0]).toEqual({ org: null, fn: null });
      const sql = await readFile(
        path.join(DEFAULT_MIGRATIONS_DIR, '20261011000100_tenancy', 'migration.sql'),
        'utf8',
      );
      await expect(c.query(sql)).rejects.toThrow(/requires a UTF8 database/);
    });
  });
});
