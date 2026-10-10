import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MIGRATION_NAME } from './rollback.js';

const pkgRoot = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = path.join(pkgRoot, 'prisma/migrations');
const dirs = (await readdir(migrationsDir, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const read = (d: string, f: string) => readFile(path.join(migrationsDir, d, f), 'utf8');
const stripComments = (sql: string) => sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
// Predates the explicit BEGIN/COMMIT rule; it is one statement, so it is already atomic.
const LEGACY_MIGRATION = '20261010000000_processed_job';
// Transaction-control statements only: a bare BEGIN opening a PL/pgSQL body has no semicolon.
const TXN_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;|^\s*START\s+TRANSACTION\b/im;

describe('transaction-control check', () => {
  it('does not flag a PL/pgSQL body with bare BEGIN / END;', () => {
    const fn =
      'CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;';
    expect(fn).not.toMatch(TXN_CONTROL);
  });

  it.each([
    'BEGIN;',
    'COMMIT;',
    'ROLLBACK;',
    'CREATE TABLE t (a int);\n  begin ;',
    'START TRANSACTION',
    'COMMIT\n;',
  ])('flags %j', (sql) => {
    expect(sql).toMatch(TXN_CONTROL);
  });
});

describe('migration files', () => {
  it('has at least one migration and only well-named directories, in strictly ascending order', () => {
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) expect(d).toMatch(MIGRATION_NAME);
    const stamps = dirs.map((d) => d.slice(0, 14));
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it.each(dirs)('%s has migration.sql and down.sql', async (d) => {
    expect((await stat(path.join(migrationsDir, d, 'migration.sql'))).isFile()).toBe(true);
    expect((await stat(path.join(migrationsDir, d, 'down.sql'))).isFile()).toBe(true);
  });

  // This Prisma version applies a migration.sql statement by statement, so atomicity
  // comes from an explicit BEGIN; ... COMMIT; around the whole file.
  it.each(dirs.filter((d) => d > LEGACY_MIGRATION))(
    '%s: migration.sql is wrapped in BEGIN; ... COMMIT;',
    async (d) => {
      const sql = stripComments(await read(d, 'migration.sql')).trim();
      expect(sql, d).toMatch(/^BEGIN\s*;/i);
      expect(sql, d).toMatch(/COMMIT\s*;$/i);
      const inner = sql.replace(/^BEGIN\s*;/i, '').replace(/COMMIT\s*;$/i, '');
      expect(inner, `${d}: nested transaction control`).not.toMatch(TXN_CONTROL);
    },
  );

  it.each(dirs)('%s: no CONCURRENTLY, and down.sql has no transaction control', async (d) => {
    for (const f of ['migration.sql', 'down.sql']) {
      const sql = stripComments(await read(d, f));
      expect(sql, `${d}/${f}`).not.toMatch(/\bCONCURRENTLY\b/i);
    }
    expect(stripComments(await read(d, 'down.sql')), `${d}/down.sql`).not.toMatch(TXN_CONTROL);
  });

  it.each(dirs)('%s: every REFERENCES clause states ON DELETE', async (d) => {
    const sql = stripComments(await read(d, 'migration.sql'));
    const clauses = sql.match(/REFERENCES\s+\w+\s*\([^)]*\)[^,;]*/gi) ?? [];
    for (const c of clauses) expect(c, `${d}: ${c}`).toMatch(/ON DELETE/i);
  });

  it.each(dirs)('%s: identifiers fit in 63 bytes', async (d) => {
    const sql = await read(d, 'migration.sql');
    const names = [...sql.matchAll(/\b(?:CONSTRAINT|INDEX|TRIGGER|TABLE|FUNCTION)\s+(\w+)/gi)].map(
      (m) => m[1]!,
    );
    for (const n of names) expect(Buffer.byteLength(n), n).toBeLessThanOrEqual(63);
  });

  it('migration_lock.toml pins postgresql', async () => {
    expect(await readFile(path.join(migrationsDir, 'migration_lock.toml'), 'utf8')).toMatch(
      /provider\s*=\s*"postgresql"/,
    );
  });

  it('no package script runs a destructive or schema-diffing Prisma command', async () => {
    const pkg = JSON.parse(await readFile(path.join(pkgRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, name).not.toMatch(/prisma\s+(migrate\s+(dev|reset)|db\s+push)/);
    }
  });

  it('schema.prisma declares no models (SQL migrations are the source of truth)', async () => {
    expect(await readFile(path.join(pkgRoot, 'prisma/schema.prisma'), 'utf8')).not.toMatch(
      /^\s*model\s+\w+/m,
    );
  });
});
