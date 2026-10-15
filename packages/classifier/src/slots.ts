import type pg from 'pg';

export interface SlotLease {
  release(): Promise<void>;
  /** Closes the session without unlocking; the server drops the lock with the connection. */
  destroy(): Promise<void>;
}

/** Per-brand in-flight cap on provider calls, across all workers. Session advisory locks die with the connection. */
export class BrandSlots {
  constructor(
    private readonly pool: pg.Pool,
    private readonly perBrand: number,
  ) {
    if (!Number.isInteger(perBrand) || perBrand < 1 || perBrand > 64)
      throw new RangeError('perBrand');
  }

  async acquire(brandId: string): Promise<SlotLease | null> {
    const c = await this.pool.connect();
    const key = `fb.classify:${brandId}`;
    try {
      for (let slot = 0; slot < this.perBrand; slot++) {
        const r = await c.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1), $2) AS ok',
          [key, slot],
        );
        if (r.rows[0]!.ok) {
          let done = false;
          return {
            release: async () => {
              if (done) return;
              done = true;
              try {
                await c.query('SELECT pg_advisory_unlock(hashtext($1), $2)', [key, slot]);
                c.release();
              } catch {
                c.release(true);
              }
            },
            destroy: async () => {
              if (done) return;
              done = true;
              c.release(true);
            },
          };
        }
      }
    } catch (e) {
      c.release(true);
      throw e;
    }
    c.release();
    return null;
  }
}
