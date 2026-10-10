import { randomUUID } from 'node:crypto';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_MIGRATIONS_DIR } from '../migrations/cli.js';
import { MIGRATION_NAME } from '../migrations/rollback.js';
import { PACKAGE_ROOT } from './prisma-cli.js';

export async function makeMigrationsDir(include: string[], extra?: { name: string; sql: string }) {
  const id = randomUUID();
  const relDir = path.join('.tmp', id, 'migrations');
  const absDir = path.join(PACKAGE_ROOT, relDir);
  await mkdir(absDir, { recursive: true });
  await cp(
    path.join(DEFAULT_MIGRATIONS_DIR, 'migration_lock.toml'),
    path.join(absDir, 'migration_lock.toml'),
  );
  for (const name of include) {
    if (!MIGRATION_NAME.test(name)) throw new Error(`bad fixture name ${name}`);
    await cp(path.join(DEFAULT_MIGRATIONS_DIR, name), path.join(absDir, name), {
      recursive: true,
    });
  }
  if (extra) {
    if (!MIGRATION_NAME.test(extra.name)) throw new Error(`bad fixture name ${extra.name}`);
    await mkdir(path.join(absDir, extra.name));
    await writeFile(path.join(absDir, extra.name, 'migration.sql'), extra.sql);
    await writeFile(path.join(absDir, extra.name, 'down.sql'), '-- fixture\n');
  }
  return {
    relDir,
    absDir,
    cleanup: () => rm(path.join(PACKAGE_ROOT, '.tmp', id), { recursive: true, force: true }),
  };
}
