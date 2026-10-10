import pg from 'pg';

export interface CreatePoolOptions {
  readonly applicationName: string;
  readonly max?: number;
  /** Required: pg emits 'error' on idle clients (e.g. Postgres restart); unhandled, it crashes the process. */
  readonly onIdleError: (err: Error) => void;
}

export function createPool(databaseUrl: URL, opts: CreatePoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl.href,
    application_name: opts.applicationName,
    max: opts.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', opts.onIdleError);
  return pool;
}
