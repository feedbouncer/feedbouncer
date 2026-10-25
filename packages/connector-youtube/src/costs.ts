// YouTube Data API v3 unit costs (determine_quota_cost). Every request is
// charged, failed and invalid ones included; each extra page costs again.
export const COST = {
  'commentThreads.list': 1,
  'comments.list': 1,
  'channels.list': 1,
  'comments.setModerationStatus': 50,
} as const;
export type YouTubeMethod = keyof typeof COST;

/** setModerationStatus takes up to 50 comma-separated ids in one call. */
export const MAX_BATCH = 50;
/** One write batch: a 1-unit probe plus the 50-unit write. */
export const BATCH_UNITS = COST['comments.list'] + COST['comments.setModerationStatus'];
