import type { Pool, PoolClient } from 'pg';

// One transaction on one client. Same COMMIT-tag check as runJobOnce: COMMIT on
// an aborted transaction answers "ROLLBACK" instead of throwing.
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  opts: { isolation?: 'repeatable read'; readOnly?: boolean } = {},
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    const modes = [
      opts.isolation && `ISOLATION LEVEL ${opts.isolation.toUpperCase()}`,
      opts.readOnly && 'READ ONLY',
    ].filter(Boolean);
    await client.query(['BEGIN', ...modes].join(' '));
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
