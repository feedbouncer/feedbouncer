# @feedbouncer/db

SQL-first migrations for Postgres, applied with `prisma migrate deploy`.

## Migration atomicity

Prisma 7.10.0 applies `migration.sql` one statement at a time, not as a single
implicit transaction (verified by the failing-migration case in
`src/migrations/workflow.integration.test.ts`). Every `migration.sql` is
therefore wrapped in an explicit `BEGIN;` ... `COMMIT;`, and `files.test.ts`
enforces it. `down.sql` must not contain transaction control: `migrate:down`
runs it inside its own transaction.

## Integration tests

Set `DATABASE_URL` to a Postgres server where the user may create databases,
then run `pnpm --filter @feedbouncer/db test:integration`. Each test creates and
drops its own `fb_test_*` database; `job-once.integration.test.ts` uses the
database named in `DATABASE_URL` directly, which must already be migrated.
