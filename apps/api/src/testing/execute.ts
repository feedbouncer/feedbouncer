import { expect } from 'vitest';
import { EXECUTE_JOB, executeActionJob } from '@feedbouncer/comments';
import { systemClock } from '@feedbouncer/connectors';
import type { JobContext } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { TestApi } from './harness.js';

/** Runs the enqueued execute job for an action the way the worker would. */
export async function runExecuteJob(
  api: TestApi,
  actionId: string,
  scope: ConnectionScope,
  platform: 'facebook' | 'instagram' = 'facebook',
  attempt = 1,
) {
  const ledger = await api.pool.query<{ id: string; payload: { actionId: string } }>(
    `SELECT id, payload FROM job_ledger WHERE job_type = $1 AND payload->>'actionId' = $2`,
    [EXECUTE_JOB.type, actionId],
  );
  expect(ledger.rows).toHaveLength(1);
  const ctx: JobContext = {
    scope,
    platform,
    jobType: EXECUTE_JOB.type,
    ledgerId: ledger.rows[0]!.id,
    attempt,
    isReplay: false,
    signal: AbortSignal.timeout(30_000),
    log: api.deps.log,
  };
  const job = executeActionJob({
    pool: api.pool,
    runtime: api.deps.connectors!.stack.runtime,
    log: api.deps.log,
    producer: api.deps.producer!,
    clock: systemClock,
  });
  return job.handle(ctx, EXECUTE_JOB.payload.parse(ledger.rows[0]!.payload));
}
