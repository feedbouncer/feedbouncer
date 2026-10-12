import type pg from 'pg';
import { runJobOnce } from '@feedbouncer/db';
import type { DeliveryLedger } from '../ports.js';

/**
 * Webhook dedupe over processed_job. The claim commits immediately, so no
 * connection or row lock is held while `work` runs. If `work` fails the claim
 * is released and the platform's retry is processed normally.
 */
export class PgDeliveryLedger implements DeliveryLedger {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workerId: string,
  ) {}

  async once(
    namespace: string,
    key: string,
    work: () => Promise<void>,
  ): Promise<'processed' | 'duplicate'> {
    const claim = await runJobOnce(
      this.pool,
      { queue: namespace, jobId: key, workerId: this.workerId },
      async () => undefined,
    );
    if (claim === 'duplicate') return 'duplicate';
    try {
      await work();
    } catch (err) {
      await this.pool
        .query('DELETE FROM processed_job WHERE queue = $1 AND job_id = $2', [namespace, key])
        .catch(() => undefined);
      throw err;
    }
    return 'processed';
  }
}
