// Session-level advisory lock on a dedicated client: no transaction is held
// open during the HTTP refresh, and a crashed process's session ends, which
// releases the lock.
//
// The pool passed in MUST be a small pool used only for these lock sessions,
// never the data pool: a refresh holds one lock client for its whole duration
// (including polling) while the work inside needs data-pool clients, so a
// shared pool saturates under concurrent refreshes and loses rotated tokens. Key: (0x46420001, hashtext(org/brand/connection)); hash
// collisions only cause extra serialization.
import type pg from 'pg';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { ConnectorError } from '../errors.js';
import type { RefreshLock } from '../ports.js';
import { scopeKey } from '../scope.js';

const CLASS_ID = 0x46420001;

export class PgRefreshLock implements RefreshLock {
  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: { timeoutMs?: number; pollMs?: number } = {},
  ) {}

  async run<T>(scope: ConnectionScope, fn: () => Promise<T>): Promise<T> {
    const key = scopeKey(scope);
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new ConnectorError('transient', 'refresh_lock_unavailable');
    }
    let broken = false;
    try {
      const deadline = Date.now() + (this.opts.timeoutMs ?? 30_000);
      for (;;) {
        const r = await client.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok',
          [CLASS_ID, key],
        );
        if (r.rows[0]?.ok) break;
        if (Date.now() >= deadline) throw new ConnectorError('transient', 'refresh_lock_timeout');
        await new Promise((res) => setTimeout(res, this.opts.pollMs ?? 100));
      }
      try {
        return await fn();
      } finally {
        await client
          .query('SELECT pg_advisory_unlock($1, hashtext($2))', [CLASS_ID, key])
          .catch(() => {
            broken = true; // destroying the client ends the session and releases the lock
          });
      }
    } finally {
      client.release(broken);
    }
  }
}
