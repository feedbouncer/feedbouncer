import type pg from 'pg';
import type { DeliveryLedger } from '../ports.js';

const DEFAULT_LEASE_MS = 5 * 60_000;

// One statement: insert a fresh claim, or take over a claim that never
// completed and whose lease has lapsed (its worker crashed).
const CLAIM_SQL = `
  INSERT INTO processed_job (queue, job_id, processed_by)
  VALUES ($1, $2, $3)
  ON CONFLICT (queue, job_id) DO UPDATE
    SET first_processed_at = now(), processed_by = EXCLUDED.processed_by
    WHERE processed_job.completed_at IS NULL
      AND processed_job.first_processed_at < now() - ($4 * interval '1 millisecond')
  RETURNING job_id`;

/**
 * Webhook dedupe over processed_job. A claim commits immediately, so no
 * connection or row lock is held while `work` runs, and becomes final only
 * when `work` succeeds. A failed `work` releases the claim; a crashed one
 * leaves it to expire after the lease. A delivery that arrives while another
 * is still in flight is refused (not reported as a duplicate), so the platform
 * retries it.
 */
export class PgDeliveryLedger implements DeliveryLedger {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workerId: string,
    private readonly leaseMs = DEFAULT_LEASE_MS,
  ) {}

  async once(
    namespace: string,
    key: string,
    work: () => Promise<void>,
  ): Promise<'processed' | 'duplicate'> {
    const claim = await this.pool.query(CLAIM_SQL, [namespace, key, this.workerId, this.leaseMs]);
    if (claim.rowCount === 0) return this.#settled(namespace, key);
    try {
      await work();
    } catch (err) {
      await this.pool
        .query('DELETE FROM processed_job WHERE queue = $1 AND job_id = $2 AND processed_by = $3', [
          namespace,
          key,
          this.workerId,
        ])
        .catch(() => undefined);
      throw err;
    }
    await this.pool.query(
      'UPDATE processed_job SET completed_at = now() WHERE queue = $1 AND job_id = $2',
      [namespace, key],
    );
    return 'processed';
  }

  async #settled(namespace: string, key: string): Promise<'duplicate'> {
    const r = await this.pool.query<{ completed_at: Date | null }>(
      `UPDATE processed_job SET duplicate_deliveries = duplicate_deliveries + 1
        WHERE queue = $1 AND job_id = $2 RETURNING completed_at`,
      [namespace, key],
    );
    if (r.rows[0]?.completed_at) return 'duplicate';
    throw new Error('webhook delivery is still being processed; retry later');
  }
}
