export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_TEXT_CODE_POINTS = 10_000;
/** Requests per minute per API key unless PUBLIC_API_RATE_LIMIT_PER_MINUTE says otherwise. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
/** Failed authentications allowed per client address per minute. */
export const AUTH_FAILURES_PER_MINUTE = 30;
/** How long a stored Idempotency-Key response is kept. */
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;
export const IDEMPOTENCY_TTL_SECONDS = IDEMPOTENCY_KEY_TTL_HOURS * 3600;
/** Largest request body the API accepts. */
export const REQUEST_BODY_LIMIT_BYTES = 64 * 1024;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
