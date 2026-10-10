import type { Pool, PoolClient } from 'pg';

export interface JobKey {
  readonly queue: string;
  readonly jobId: string;
  readonly workerId: string;
}
export type JobOutcome = 'processed' | 'duplicate';

const MAX_LEN = 200;
const KEY_FIELDS = ['queue', 'jobId', 'workerId'] as const;

export function validateJobKey(key: JobKey): void {
  for (const field of KEY_FIELDS) {
    const value: unknown = key[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LEN) {
      throw new RangeError(
        `JobKey.${field} must be a non-empty string of at most ${MAX_LEN} characters`,
      );
    }
  }
}

// Claim + work + commit in ONE transaction:
// - A concurrent delivery of the same key blocks on the uncommitted row, then
//   sees it and is counted as a duplicate.
// - If work throws, the claim rolls back, so a retry processes normally.
// Limitation: the transaction stays open while `work` runs. Fine for DB-only
// work; jobs calling external APIs need a claim/complete state machine
// (job-queue ticket). `work` must use the provided client, not the pool
// (otherwise a saturated pool can stall).
const CLAIM_SQL = `
  INSERT INTO processed_job (queue, job_id, processed_by)
  VALUES ($1, $2, $3)
  ON CONFLICT (queue, job_id)
  DO UPDATE SET duplicate_deliveries = processed_job.duplicate_deliveries + 1
  RETURNING duplicate_deliveries`;

export async function runJobOnce(
  pool: Pool,
  key: JobKey,
  work: (client: PoolClient) => Promise<void>,
): Promise<JobOutcome> {
  validateJobKey(key);
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ duplicate_deliveries: number }>(CLAIM_SQL, [
      key.queue,
      key.jobId,
      key.workerId,
    ]);
    if ((rows[0]?.duplicate_deliveries ?? 0) > 0) {
      await client.query('COMMIT');
      return 'duplicate';
    }
    await work(client);
    // COMMIT on an aborted transaction does not throw: Postgres answers with the
    // command tag ROLLBACK. Treat that as failure, or the claim and the work
    // would be silently lost while we report success.
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') {
      throw new Error(
        'job transaction was aborted and rolled back; work and claim were not committed',
      );
    }
    return 'processed';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
