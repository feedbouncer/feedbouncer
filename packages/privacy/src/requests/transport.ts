import { z } from 'zod';

export const PRIVACY_QUEUE = 'privacy';

/** Redis carries only the request id: the identifiers stay sealed in Postgres. */
export const PrivacyJobData = z.strictObject({ v: z.literal(1), requestId: z.uuid() });
export type PrivacyJobData = z.infer<typeof PrivacyJobData>;

export const PRIVACY_JOB_NAME = 'process';

const ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 5_000;

/** The slice of a BullMQ queue the privacy producers use. */
export interface PrivacyQueue {
  add(name: string, data: PrivacyJobData, opts: object): Promise<unknown>;
}

/** Queues a request under its own id, so queuing it twice is a no-op. */
export function enqueuePrivacyRequest(
  queue: PrivacyQueue,
  requestId: string,
  backoffMs = DEFAULT_BACKOFF_MS,
): Promise<unknown> {
  return queue.add(
    PRIVACY_JOB_NAME,
    { v: 1, requestId },
    {
      jobId: requestId,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: backoffMs },
      removeOnComplete: true,
      removeOnFail: 1000,
    },
  );
}
