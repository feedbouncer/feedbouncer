import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listMigrationDirs } from './rollback.js';

const NAME = /^[a-z0-9_]{1,60}$/;

const UP = `-- Forward migration. Keep everything between BEGIN; and COMMIT;: Prisma runs this
-- file statement by statement, so the explicit transaction is what makes it atomic.
-- Never use CREATE INDEX CONCURRENTLY here. State ON DELETE on every REFERENCES.
-- Conventions: packages/db/README.md
BEGIN;
SET LOCAL lock_timeout = '10s';

COMMIT;
`;
const DOWN = `-- Reverse every statement in migration.sql, in reverse order. No IF EXISTS:
-- an unexpected state must fail loudly. Runs inside migrate:down's transaction.

`;

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export async function createMigration(
  migrationsDir: string,
  name: string,
  now = new Date(),
): Promise<string> {
  if (!NAME.test(name)) throw new Error('Migration name must match ^[a-z0-9_]{1,60}$');
  const ts = stamp(now);
  const latest = (await listMigrationDirs(migrationsDir)).at(-1);
  if (latest && latest.slice(0, 14) >= ts)
    throw new Error(`Timestamp ${ts} must be newer than ${latest}`);
  const dirName = `${ts}_${name}`;
  const target = path.join(migrationsDir, dirName);
  await mkdir(target);
  await writeFile(path.join(target, 'migration.sql'), UP, { flag: 'wx' });
  await writeFile(path.join(target, 'down.sql'), DOWN, { flag: 'wx' });
  return dirName;
}
