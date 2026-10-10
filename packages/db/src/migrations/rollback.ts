import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

/** Prisma Migrate's advisory-lock key. Shared so deploy and rollback never interleave. */
export const PRISMA_MIGRATE_LOCK_ID = 72707369;
export const MIGRATION_NAME = /^\d{14}_[a-z0-9_]{1,60}$/;

export class RollbackError extends Error {
  override name = 'RollbackError';
}

export type RollbackResult =
  | { status: 'rolled_back'; migration: string }
  | { status: 'nothing_to_roll_back' };

export async function listMigrationDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && MIGRATION_NAME.test(e.name))
    .map((e) => e.name)
    .sort();
}

const shown = (s: string) => JSON.stringify(s.slice(0, 80));

/**
 * Reverts the newest applied migration: runs its down.sql and deletes its
 * _prisma_migrations row in one transaction, so `prisma migrate deploy`
 * re-applies it next time. Holds Prisma's advisory lock throughout.
 */
export async function rollbackLatest(
  client: pg.ClientBase,
  migrationsDir: string,
): Promise<RollbackResult> {
  await client.query('SELECT pg_advisory_lock($1)', [PRISMA_MIGRATE_LOCK_ID]);
  try {
    const ledger = await client.query<{ t: string | null }>(
      "SELECT to_regclass('public._prisma_migrations') AS t",
    );
    if (ledger.rows[0]?.t == null) return { status: 'nothing_to_roll_back' };

    const failed = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY migration_name',
    );
    if (failed.rowCount) {
      const name = failed.rows[0]!.migration_name;
      throw new RollbackError(
        `Migration ${shown(name)} failed earlier and is unresolved. Fix it first: ` +
          `prisma migrate resolve --rolled-back ${MIGRATION_NAME.test(name) ? name : '<name>'}`,
      );
    }

    const latest = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name DESC LIMIT 1',
    );
    if (!latest.rowCount) return { status: 'nothing_to_roll_back' };
    const name = latest.rows[0]!.migration_name;

    // Never build a path from ledger data: only names that exist as directories are accepted.
    const known = await listMigrationDirs(migrationsDir);
    if (!known.includes(name)) {
      throw new RollbackError(
        `Latest applied migration ${shown(name)} is not in ${migrationsDir}; refusing.`,
      );
    }
    let downSql: string;
    try {
      downSql = await readFile(path.join(migrationsDir, name, 'down.sql'), 'utf8');
    } catch {
      throw new RollbackError(`Migration ${name} has no down.sql; refusing.`);
    }

    await client.query('BEGIN');
    try {
      await client.query(downSql);
      await client.query('DELETE FROM _prisma_migrations WHERE migration_name = $1', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    return { status: 'rolled_back', migration: name };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [PRISMA_MIGRATE_LOCK_ID]);
  }
}
