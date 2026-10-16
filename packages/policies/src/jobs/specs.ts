import { z } from 'zod';

export const POLICY_LANE = 'policy';
const SHA = z.string().regex(/^[0-9a-f]{64}$/);
export const POLICY_TRIGGER = z.union([
  z.literal('ingest'),
  z.string().regex(/^run:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
]);

/** Provider attempts handled in-job; the 6th framework attempt only covers crashes. */
export const MAX_POLICY_PROVIDER_ATTEMPTS = 5;
/** Fixed delay for a per-brand cap deferral; the framework adds at most 10% jitter. */
export const POLICY_BRAND_BUSY_RETRY_MS = 30_000;

export const PolicyEvaluatePayload = z.strictObject({
  commentId: z.uuid(),
  bodySha256: SHA,
  trigger: POLICY_TRIGGER,
  /** Epoch ms when the check was requested; bounds queue wait. Not part of the idempotency key. */
  requestedAt: z.number().int().positive(),
});
export type PolicyEvaluatePayload = z.output<typeof PolicyEvaluatePayload>;

export const POLICY_EVALUATE_JOB = {
  type: 'policy_evaluate' as const,
  lane: POLICY_LANE,
  platforms: 'all' as const,
  payload: PolicyEvaluatePayload,
  externalRef: (p: PolicyEvaluatePayload) =>
    `pol:${p.commentId}:${p.bodySha256.slice(0, 32)}:${p.trigger}`,
  timeoutMs: 45_000,
  policy: {
    maxAttempts: MAX_POLICY_PROVIDER_ATTEMPTS + 1,
    baseDelayMs: 5_000,
    maxDelayMs: 300_000,
    maxDeferrals: 400,
    maxDeferredMs: 14_400_000,
  },
};

export const PolicyPreviewPayload = z.strictObject({
  previewId: z.uuid(),
  chunk: z.number().int().min(0).max(100),
});
export type PolicyPreviewPayload = z.output<typeof PolicyPreviewPayload>;
export const PREVIEW_CHUNK = 10;

export const POLICY_PREVIEW_JOB = {
  type: 'policy_preview' as const,
  lane: POLICY_LANE,
  platforms: 'all' as const,
  payload: PolicyPreviewPayload,
  externalRef: (p: PolicyPreviewPayload) => `pol-preview:${p.previewId}:${p.chunk}`,
  timeoutMs: 300_000,
  policy: {
    maxAttempts: 6,
    baseDelayMs: 5_000,
    maxDelayMs: 120_000,
    maxDeferrals: 400,
    maxDeferredMs: 3_600_000,
  },
};

export const PolicyRunPayload = z.strictObject({ runId: z.uuid() });
export type PolicyRunPayload = z.output<typeof PolicyRunPayload>;

export const POLICY_RUN_JOB = {
  type: 'policy_run' as const,
  platforms: 'all' as const,
  payload: PolicyRunPayload,
  externalRef: (p: PolicyRunPayload) => `pol-run:${p.runId}`,
  timeoutMs: 120_000,
  policy: { maxAttempts: 3 },
};

export const POLICY_JOB_SPECS = [POLICY_EVALUATE_JOB, POLICY_PREVIEW_JOB, POLICY_RUN_JOB] as const;
