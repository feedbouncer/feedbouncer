import type pg from 'pg';
import { runJobOnce } from '@feedbouncer/db';
import type { DeliveryLedger } from '../ports.js';

/** Webhook dedupe over processed_job: claim, work and commit in one transaction. */
export class PgDeliveryLedger implements DeliveryLedger {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workerId: string,
  ) {}

  once(
    namespace: string,
    key: string,
    work: () => Promise<void>,
  ): Promise<'processed' | 'duplicate'> {
    return runJobOnce(this.pool, { queue: namespace, jobId: key, workerId: this.workerId }, () =>
      work(),
    );
  }
}
