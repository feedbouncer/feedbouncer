import path from 'node:path';
import { defineConfig, env } from 'prisma/config';

// Test-only override so integration tests can run prefixes of the migration
// history or a deliberately broken fixture. Must stay inside packages/db/.tmp/.
function migrationsPath(): string {
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const override = process.env.FB_MIGRATIONS_DIR;
  if (!override) return 'prisma/migrations';
  const tmpRoot = path.resolve(process.cwd(), '.tmp') + path.sep;
  const resolved = path.resolve(process.cwd(), override);
  if (!resolved.startsWith(tmpRoot))
    throw new Error('FB_MIGRATIONS_DIR must point inside packages/db/.tmp/');
  return resolved;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: migrationsPath() },
  datasource: { url: env('DATABASE_URL') },
});
