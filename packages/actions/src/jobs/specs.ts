import * as z from 'zod';
import type { Platform } from '@feedbouncer/connectors';
import type { RetryPolicy } from '@feedbouncer/jobs';
import { UUID } from '@feedbouncer/service-runtime';

// Only characters the job ledger accepts in an external ref.
const CAUSE = /^[A-Za-z0-9_:-]{1,100}$/;

export const actionRunAdvancePayload = z.strictObject({
  runId: z.string().regex(UUID),
  /** Final steps the waker saw, plus one (0 for the first advance of a run). */
  settled: z.number().int().min(0).max(7),
  /**
   * What woke the run, `<stepId>:<actionStatus>`. Part of the ref so a deferral and the
   * later outcome of the same step are two distinct wake-ups, not one deduplicated job.
   */
  cause: z.string().max(100).regex(CAUSE).optional(),
});
export type ActionRunAdvancePayload = z.infer<typeof actionRunAdvancePayload>;

export const ACTION_RUN_ADVANCE_JOB = {
  type: 'action_run_advance' as const,
  platforms: ['facebook', 'instagram'] as readonly Platform[] | 'all',
  payload: actionRunAdvancePayload,
  externalRef: (p: ActionRunAdvancePayload): string =>
    `run:${p.runId}:${p.settled}:${p.cause ?? ''}`,
  policy: { maxAttempts: 8 } satisfies Partial<RetryPolicy>,
};
