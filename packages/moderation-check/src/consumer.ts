import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { createPool } from '@feedbouncer/db';
import { errorFields, type Logger } from '@feedbouncer/service-runtime';
import { checkText, type CheckDeps } from './check.js';
import {
  CheckJobData,
  MODERATION_CHECK_QUEUE,
  validateCheckText,
  type CheckJobResult,
} from './transport.js';

export interface ModerationCheckWorkerDeps {
  connection: Redis;
  prefix: string;
  concurrency: number;
  pool: ReturnType<typeof createPool>;
  deps: CheckDeps;
  log: Logger;
  now?: () => number;
}

/** Runs the shared moderation pipeline on submitted text. The text is never logged or stored. */
export function startModerationCheckWorker(d: ModerationCheckWorkerDeps): {
  close(): Promise<void>;
} {
  const now = d.now ?? Date.now;

  async function process(job: Job): Promise<CheckJobResult> {
    const parsed = CheckJobData.safeParse(job.data);
    if (!parsed.success || !validateCheckText(parsed.data.text).ok) {
      throw new Error('invalid_check_job');
    }
    const { organizationId, brandId, text, deadlineAt } = parsed.data;
    try {
      if (now() > deadlineAt) return { kind: 'expired' };
      const brand = await d.pool.query(
        'SELECT 1 FROM brand WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL',
        [organizationId, brandId],
      );
      if (brand.rowCount === 0) return { kind: 'brand_gone' };
      const started = now();
      const result = await checkText(d.deps, { organizationId, brandId }, text, deadlineAt);
      d.log.info('moderation_check.done', {
        jobId: job.id ?? null,
        organizationId,
        brandId,
        verdict: result.verdict,
        reasonCode: result.reasonCode,
        durationMs: now() - started,
      });
      return { kind: 'done', result };
    } catch (err) {
      // Error messages can echo the submitted text, so only the error's shape is logged.
      const { error, errorCode, errorClass } = errorFields(err);
      d.log.error('moderation_check.failed', {
        jobId: job.id ?? null,
        organizationId,
        error: error ?? null,
        errorCode: errorCode ?? null,
        errorClass: errorClass ?? null,
      });
      throw new Error('moderation_check_failed');
    }
  }

  const worker = new Worker(MODERATION_CHECK_QUEUE, process, {
    connection: d.connection,
    prefix: d.prefix,
    concurrency: d.concurrency,
    autorun: true,
  });
  worker.on('error', (err) => d.log.error('moderation_check.worker_error', errorFields(err)));
  return { close: () => worker.close() };
}
