export const WEBHOOK_EVENT_TYPES = ['comment.received', 'comment.hidden', 'item.flagged'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21600, 43200] as const;
export const MAX_ATTEMPTS = 7;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const LEASE_SECONDS = 60;
export const DISABLE_AFTER_CONSECUTIVE_FAILURES = 20;
export const DISABLE_MIN_FAILING_SECONDS = 86_400;
export const ROTATION_OVERLAP_SECONDS = 86_400;
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const PER_ENDPOINT_IN_FLIGHT = 4;
export const PER_ORG_IN_FLIGHT = 8;
export const MAX_ENDPOINTS_PER_ORG = 10;
export const RETENTION_DAYS = 30;
