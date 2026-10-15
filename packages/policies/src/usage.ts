// Monthly model-call budget per brand (UTC calendar months). One row per
// (brand, month); consume is a single conditional upsert, so concurrent workers
// can never take more than `limit` units between them.
import type pg from 'pg';
import type { BrandScope } from '@feedbouncer/rules';

export interface PolicyUsageSnapshot {
  used: number;
  limit: number;
  resetsAt: Date;
}

export class PgPolicyUsage {
  readonly #pool: pg.Pool;
  readonly #clock: { now(): number };
  constructor(pool: pg.Pool, clock: { now(): number } = Date) {
    this.#pool = pool;
    this.#clock = clock;
  }

  #period(): { start: string; resetsAt: Date } {
    const d = new Date(this.#clock.now());
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    return {
      start: start.toISOString().slice(0, 10),
      resetsAt: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)),
    };
  }

  /** Atomically takes one model call from this month's budget. False when none is left. */
  async consume(s: BrandScope, limit: number): Promise<boolean> {
    if (!(limit > 0)) return false;
    // The brand join keeps a forged organization from creating or touching a row.
    const r = await this.#pool.query(
      `INSERT INTO policy_usage (organization_id, brand_id, period_start, model_calls)
       SELECT b.organization_id, b.id, $3::date, 1 FROM brand b WHERE b.organization_id = $1 AND b.id = $2
       ON CONFLICT (brand_id, period_start) DO UPDATE SET model_calls = policy_usage.model_calls + 1
        WHERE policy_usage.model_calls < $4 AND policy_usage.organization_id = $1
       RETURNING model_calls`,
      [s.organizationId, s.brandId, this.#period().start, limit],
    );
    return r.rowCount === 1;
  }

  async current(s: BrandScope, limit: number): Promise<PolicyUsageSnapshot> {
    const p = this.#period();
    const r = await this.#pool.query<{ n: number }>(
      `SELECT model_calls AS n FROM policy_usage
        WHERE organization_id = $1 AND brand_id = $2 AND period_start = $3::date`,
      [s.organizationId, s.brandId, p.start],
    );
    return { used: r.rows[0]?.n ?? 0, limit, resetsAt: p.resetsAt };
  }
}
