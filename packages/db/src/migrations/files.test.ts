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

  it.each(dirs)('%s: no explicit transaction control or CONCURRENTLY', async (d) => {
    for (const f of ['migration.sql', 'down.sql']) {
      const sql = stripComments(await read(d, f));
      expect(sql, `${d}/${f}`).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im);
      expect(sql, `${d}/${f}`).not.toMatch(/\bCONCURRENTLY\b/i);
    }
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
