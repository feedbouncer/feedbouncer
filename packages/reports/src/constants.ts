import { RETRY_DELAYS_MS } from '@feedbouncer/alerts/constants';

export const SECONDS_SAVED_PER_HIDDEN_COMMENT = 30;
export const TOP_ADS_LIMIT = 5;
export const TOP_ADS_MIN_COMMENTS = 10;
export const SEND_HOUR_LOCAL = 8;
export const CATCHUP_HOURS = 24;
export const SCHEDULER_EVERY_MS = 60_000;
export const DISPATCH_EVERY_MS = 10_000;
export const SCHEDULER_BATCH = 20;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const DASHBOARD_LOOKBACK_WEEKS = 52;
/** 32 random bytes as base64url. */
export const REPORT_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
