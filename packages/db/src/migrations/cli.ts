import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EnvError, PG_PROTOCOLS, readUrl, redact, type Env } from '@feedbouncer/service-runtime';
import { createPool } from '../pool.js';
import { createMigration } from './new-migration.js';
import { RollbackError, rollbackLatest } from './rollback.js';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../prisma/migrations', import.meta.url),
);

const USAGE = `usage:
  migrate:down --yes-destroy-data   revert the newest applied migration (runs its down.sql; drops data)
  migrate:new <name>                scaffold prisma/migrations/<timestamp>_<name>/{migration,down}.sql`;

interface Out {
  log(s: string): void;
  error(s: string): void;
}

export async function main(argv: string[], env: Env, out: Out): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { 'yes-destroy-data': { type: 'boolean' } },
    });
  } catch {
    out.error(USAGE);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;

  if (command === 'new') {
    if (rest.length !== 1) {
      out.error(USAGE);
      return 2;
    }
    try {
      const dir = await createMigration(DEFAULT_MIGRATIONS_DIR, rest[0]!);
      out.log(`created prisma/migrations/${dir}/migration.sql and down.sql`);
      return 0;
    } catch (err) {
      out.error((err as Error).message);
      return 1;
    }
  }

  if (command === 'down' && rest.length === 0) {
    if (!parsed.values['yes-destroy-data']) {
      out.error('migrate:down drops tables and data. Re-run with --yes-destroy-data to confirm.');
      return 2;
    }
    let url: URL;
    try {
      url = readUrl(env, 'DATABASE_URL', PG_PROTOCOLS);
    } catch (err) {
      out.error(err instanceof EnvError ? err.message : 'DATABASE_URL is invalid');
      return 1;
    }
    const pool = createPool(url, {
      applicationName: 'feedbouncer-migrate-down',
      max: 1,
      onIdleError: () => {},
    });
    try {
      const client = await pool.connect();
      try {
        const result = await rollbackLatest(client, DEFAULT_MIGRATIONS_DIR);
        out.log(
          result.status === 'rolled_back'
            ? `rolled back ${result.migration}`
            : 'nothing to roll back',
        );
        return 0;
      } finally {
        client.release();
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      const msg =
        err instanceof RollbackError ? err.message : redact(String((err as Error).message));
      out.error(`migrate:down failed${code ? ` (${code})` : ''}: ${msg}`);
      return 1;
    } finally {
      await pool.end();
    }
  }

  out.error(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env, console);
}
