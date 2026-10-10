import { defineConfig, env } from 'prisma/config';

// Used only by the integration tests (`prisma --config prisma.test.config.ts`) to run
// prefixes of the migration history or a deliberately broken fixture.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  migrations: { path: process.env.FB_MIGRATIONS_DIR ?? 'prisma/migrations' },
  datasource: { url: env('DATABASE_URL') },
});
