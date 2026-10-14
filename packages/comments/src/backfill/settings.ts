export const BACKFILL_PLATFORMS = ['facebook', 'instagram'] as const;
export type BackfillPlatform = (typeof BACKFILL_PLATFORMS)[number];

export interface BackfillSettings {
  windowDays: number;
  maxComments: number;
  pageSize: number;
  softDeadlineMs: number;
  jobTimeoutMs: number;
  staleAfterMs: number;
  gapOverlapMs: number;
  maxSkippedRecorded: number;
}

export const BACKFILL_DEFAULTS: BackfillSettings = {
  windowDays: 30,
  maxComments: 2000,
  pageSize: 100,
  softDeadlineMs: 240_000,
  jobTimeoutMs: 300_000,
  staleAfterMs: 26 * 3_600_000,
  gapOverlapMs: 3_600_000,
  maxSkippedRecorded: 50,
};

export const isBackfillPlatform = (p: string): p is BackfillPlatform =>
  (BACKFILL_PLATFORMS as readonly string[]).includes(p);
