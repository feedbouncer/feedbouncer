// Free of Node and database imports, so the web app can use it.
export const COMMENT_STATUSES = ['new', 'flagged', 'awaiting_action', 'reviewed'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];
