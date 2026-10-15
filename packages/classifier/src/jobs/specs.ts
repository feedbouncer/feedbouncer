import { z } from 'zod';

export const CLASSIFIER_LANE = 'classify';
const SHA = z.string().regex(/^[0-9a-f]{64}$/);
export const TRIGGER_KEY = z.union([
  z.literal('ingest'),
  z.string().regex(/^rerun:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
]);

export const ClassifyPayload = z.strictObject({
  commentId: z.uuid(),
  bodySha256: SHA,
  trigger: TRIGGER_KEY,
  /** Epoch ms when classification was requested; bounds queue wait. Not part of the idempotency key. */
  requestedAt: z.number().int().positive(),
});
export type ClassifyPayload = z.output<typeof ClassifyPayload>;

/** 3 provider attempts are handled in-job; the 4th framework attempt only covers crashes. */
export const MAX_PROVIDER_ATTEMPTS = 3;

/** Fixed delay for a per-brand cap deferral; the framework adds at most 10% jitter. */
export const BRAND_BUSY_RETRY_MS = 30_000;
/** Longest CLASSIFIER_MAX_WAIT_MINUTES an operator may configure. */
export const MAX_CONFIGURABLE_WAIT_MS = 90 * 60_000;

export const CLASSIFY_JOB = {
  type: 'comment_classify' as const,
  lane: CLASSIFIER_LANE,
  platforms: 'all' as const,
  payload: ClassifyPayload,
  externalRef: (p: ClassifyPayload) =>
    `clf:${p.commentId}:${p.bodySha256.slice(0, 32)}:${p.trigger}`,
  timeoutMs: 30_000,
  policy: {
    maxAttempts: MAX_PROVIDER_ATTEMPTS + 1,
    baseDelayMs: 2_000,
    maxDelayMs: 30_000,
    maxDeferrals: 200,
    maxDeferredMs: 7_200_000,
  },
};

export const RerunPayload = z.strictObject({ runId: z.uuid() });
export type RerunPayload = z.output<typeof RerunPayload>;
export const RERUN_MAX_COMMENTS_PER_CONNECTION = 5_000;

export const CLASSIFIER_RERUN_JOB = {
  type: 'classifier_rerun' as const,
  lane: CLASSIFIER_LANE,
  platforms: 'all' as const,
  payload: RerunPayload,
  externalRef: (p: RerunPayload) => `clf-rerun:${p.runId}`,
  timeoutMs: 300_000,
  policy: { maxAttempts: 3 },
};

export const CLASSIFIER_JOB_SPECS = [CLASSIFY_JOB, CLASSIFIER_RERUN_JOB] as const;
