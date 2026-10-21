import type pg from 'pg';

const PURGE_LOCK = 'fb.retention_purge';

/**
 * Runs `fn` while holding the instance-wide purge lock, a session advisory lock on
 * a client of its own, or returns `{ acquired: false }` at once if another
 * process holds it. The lock is released in every case, and a client whose
 * unlock failed is discarded so the session (and its lock) ends with it.
 */
export async function withPurgeLock<T>(
  pool: pg.Pool,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await pool.connect();
  let broken = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [PURGE_LOCK],
    );
    if (!rows[0]?.locked) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [PURGE_LOCK]).catch(() => {
        broken = true;
      });
    }
  } finally {
    client.release(broken);
  }
}
