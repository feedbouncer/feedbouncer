export const CREDENTIAL_NAME = 'feedBouncerApi';

export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_429_RETRIES = 3;
export const DEFAULT_BACKOFF_SECONDS = [1, 2, 4];
export const MAX_RETRY_AFTER_SECONDS = 60;

export const PAGE_SIZE = 100;
export const DEFAULT_LIMIT = 50;
export const RETURN_ALL_MAX = 10_000;

export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const DEDUPE_MAX_IDS = 1000;
export const DEDUPE_TTL_MS = 31 * 86_400_000;

export const ACTION_POLL_MS = 1000;
export const ACTION_WAIT_MS = 15_000;

/** Operation ids the server's /v1/openapi.json must contain for this package to work. */
export const REQUIRED_OPERATIONS = [
  'getApiKey',
  'listComments',
  'getComment',
  'hideComment',
  'unhideComment',
  'getAction',
  'listRules',
  'listWebhookEndpoints',
  'createWebhookEndpoint',
  'getWebhookEndpoint',
  'deleteWebhookEndpoint',
] as const;
