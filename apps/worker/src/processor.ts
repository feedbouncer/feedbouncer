import type { JobKey, JobOutcome } from '@feedbouncer/db';
import type { Logger } from '@feedbouncer/service-runtime';

export const SYSTEM_QUEUE = 'system';
export const SELFTEST_JOB = 'selftest';

export type RunOnce = (key: JobKey, work: () => Promise<void>) => Promise<JobOutcome>;
export interface ProcessableJob {
  readonly id?: string | undefined;
  readonly name: string;
  readonly queueName: string;
  readonly data: unknown;
}
export interface ProcessorDeps {
  readonly runOnce: RunOnce;
  readonly workerId: string;
  readonly log: Logger;
  readonly sleep: (ms: number) => Promise<void>;
}

export function parseSelftestData(data: unknown): { delayMs: number } {
  const delayMs = (data as { delayMs?: unknown } | null)?.delayMs;
  if (typeof delayMs !== 'number' || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1_000) {
    throw new Error('selftest job data.delayMs must be an integer between 0 and 1000');
  }
  return { delayMs };
}

// Every job goes through runOnce so that redeliveries (stalled jobs, retries,
// extra replicas) never repeat side effects. See packages/db/src/job-once.ts.
export function createProcessor(deps: ProcessorDeps) {
  return async (job: ProcessableJob): Promise<JobOutcome> => {
    if (!job.id) throw new Error('Refusing to process a job without an id');
    if (job.name !== SELFTEST_JOB) throw new Error(`Unknown job name on queue ${job.queueName}`);
    const { delayMs } = parseSelftestData(job.data);
    const outcome = await deps.runOnce(
      { queue: job.queueName, jobId: job.id, workerId: deps.workerId },
      () => deps.sleep(delayMs),
    );
    if (outcome === 'duplicate') deps.log.warn('duplicate delivery skipped', { jobId: job.id });
    return outcome;
  };
}
