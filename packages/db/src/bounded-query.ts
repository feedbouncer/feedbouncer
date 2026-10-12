import type { Pool, QueryResultRow } from 'pg';
import { withTimeout } from '@feedbouncer/service-runtime';

/**
 * Runs one read-only statement with a server-side statement_timeout (so a stuck
 * query is cancelled by Postgres, not just abandoned) and a client-side bound
 * (one second longer) that also covers waiting for a pooled connection.
 */
export async function boundedQuery<R extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[],
  timeoutMs: number,
): Promise<R[]> {
  const run = async (): Promise<R[]> => {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
      const { rows } = await client.query<R>(text, [...values]);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      broken = true;
      throw err;
    } finally {
      // An errored connection is destroyed rather than returned to the pool.
      client.release(broken ? true : undefined);
    }
  };
  return withTimeout(run(), timeoutMs + 1_000, 'read-only query');
}
