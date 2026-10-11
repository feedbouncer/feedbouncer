import type { Pool, PoolClient } from 'pg';

// One transaction on one client. Same COMMIT-tag check as runJobOnce: COMMIT on
// an aborted transaction answers "ROLLBACK" instead of throwing.
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') {
      throw new Error('transaction was aborted and rolled back; nothing was committed');
    }
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
