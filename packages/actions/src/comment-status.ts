// Free of Node and database imports, so the web app can use it.
export const COMMENT_STATUSES = ['new', 'flagged', 'awaiting_action', 'reviewed'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

/** Platforms whose comments are listed (every connector platform except Meta ads, which holds none). */
export const LISTABLE_PLATFORMS = [
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'threads',
  'linkedin',
  'x',
  'bluesky',
  'tiktok_ads',
] as const;

/** Shape of a category slug in a filter value. `_` cannot start one, so `_none` stays distinct. */
export const CATEGORY_SLUG = /^[a-z][a-z0-9_]{0,99}$/;
