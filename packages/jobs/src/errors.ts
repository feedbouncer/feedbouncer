export const ENQUEUE_ERROR_CODES = [
  'unknown_platform',
  'unknown_job_type',
  'invalid_scope',
  'invalid_payload',
  'payload_too_large',
  'payload_contains_secret',
  'invalid_idempotency_key',
  'connection_not_found',
] as const;
export type EnqueueErrorCode = (typeof ENQUEUE_ERROR_CODES)[number];

/** Message is the code only: never echoes payload, key or scope values. */
export class JobEnqueueError extends Error {
  override name = 'JobEnqueueError';
  constructor(readonly code: EnqueueErrorCode) {
    super(`job not enqueued: ${code}`);
  }
}
