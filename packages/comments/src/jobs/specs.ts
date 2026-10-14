import * as z from 'zod';
import type { Platform } from '@feedbouncer/connectors';
import { JobError, type JobDefinition, type RetryPolicy } from '@feedbouncer/jobs';

// Generic external-id shape (Graph ids are digits and underscores). Only safe
// characters, so ids can join the idempotency ref. The comment id is capped at
// 200 so `${id}:updated:${sec}:${changeId}` always fits the 256-character ref limit.
const ID = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.-]+$/);

export const ingestPayload = z.strictObject({
  sourceExternalId: ID,
  commentExternalId: ID.max(200),
  event: z.enum(['created', 'updated', 'deleted']),
  /** The platform's own event time (seconds). Part of an edit's identity, stable across retries. */
  platformEventSec: z.number().int().min(1).max(10_000_000_000),
  /** Identifies this change within its delivery (hash of delivery key and position), stable across redelivery. Separates edits that share a second. */
  changeId: z.string().regex(/^[0-9a-f]{16}$/),
});
export type IngestPayload = z.infer<typeof ingestPayload>;

export const INGEST_JOB = {
  // Job type names are snake_case (JobRegistry and job_ledger_job_type_check).
  type: 'comment_ingest' as const,
  payload: ingestPayload,
  externalRef: (p: IngestPayload): string =>
    p.event === 'updated'
      ? `${p.commentExternalId}:updated:${p.platformEventSec}:${p.changeId}`
      : `${p.commentExternalId}:${p.event}`,
  policy: { maxAttempts: 8 } satisfies Partial<RetryPolicy>,
  platforms: ['facebook', 'instagram'] as readonly Platform[] | 'all',
};

export const executePayload = z.strictObject({ actionId: z.uuid() });
export type ExecutePayload = z.infer<typeof executePayload>;

export const EXECUTE_JOB = {
  type: 'moderation_execute' as const,
  payload: executePayload,
  externalRef: (p: ExecutePayload): string => `action:${p.actionId}`,
  policy: { maxAttempts: 8 } satisfies Partial<RetryPolicy>,
  platforms: ['facebook', 'instagram'] as readonly Platform[] | 'all',
};

// `${connectionId}:${audit sequence}` of the connection.authorized (setup) or
// connection.disconnected (teardown) event: unique per (re)connect, stable across retries.
export const lifecyclePayload = z.strictObject({
  op: z.enum(['setup', 'teardown']),
  nonce: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,19}$/),
});
export type LifecyclePayload = z.infer<typeof lifecyclePayload>;

export const LIFECYCLE_JOB = {
  type: 'connection_lifecycle' as const,
  payload: lifecyclePayload,
  externalRef: (p: LifecyclePayload): string => `${p.op}:${p.nonce}`,
  policy: { maxAttempts: 6 } satisfies Partial<RetryPolicy>,
  platforms: 'all' as readonly Platform[] | 'all',
};

export const discoveryPayload = z.strictObject({ bucket: z.number().int().nonnegative() });
export type DiscoveryPayload = z.infer<typeof discoveryPayload>;

// One run lists every active ad of an ad account; `bucket` is a time slot
// (scheduler-chosen) that makes each cycle a distinct ledger entry.
export const DISCOVERY_JOB = {
  type: 'ad_discovery' as const,
  payload: discoveryPayload,
  externalRef: (p: DiscoveryPayload): string => `discover:${p.bucket}`,
  timeoutMs: 300_000,
  platforms: ['meta_ads'] as readonly Platform[] | 'all',
};

/** For processes that enqueue but never run jobs (the API): same type, payload and key; no handler. */
export function enqueueOnly<P>(spec: {
  type: string;
  payload: z.ZodType<P>;
  externalRef(p: P): string;
  policy?: Partial<RetryPolicy>;
  platforms: readonly Platform[] | 'all';
}): JobDefinition<P> {
  return {
    type: spec.type,
    payload: spec.payload,
    externalRef: (p) => spec.externalRef(p),
    ...(spec.policy ? { policy: spec.policy } : {}),
    platforms: spec.platforms,
    handle: async () => {
      throw new JobError('non_retryable', 'not_a_worker');
    },
  };
}
