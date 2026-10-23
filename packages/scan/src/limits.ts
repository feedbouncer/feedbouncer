export const MAX_ADS = 25;
export const WINDOW_DAYS = 30;
export const MAX_COMMENTS_PER_AD = 400;
export const MIN_RELIABLE_SAMPLE = 20;
export const UNCERTAIN_FLOOR = 0.5;
export const FETCH_DEADLINE_MS = 120_000;
export const JOB_DEADLINE_MS = 240_000;
/** Fetching stops early enough to leave classification at least this much of the job. */
export const CLASSIFY_RESERVE_MS = 90_000;
export const STALE_RUNNING_MS = 600_000;
export const STALE_QUEUED_MS = 900_000;
export const MAX_EXAMPLES_PER_CATEGORY = 3;
export const MAX_UNCERTAIN_EXAMPLES = 3;
export const EXAMPLE_MAX_CODE_POINTS = 280;
export const MAX_AD_ACCOUNTS = 10;
export const MAX_AD_PAGES_PER_ACCOUNT = 5;
