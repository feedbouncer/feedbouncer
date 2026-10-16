// Review mode for comments: which action kinds automation may not take while a
// connection's window is active. The window state itself lives with the connection
// directory (@feedbouncer/connectors), which stamps it on first activation.
import type { ActionKind } from './action-kinds.js';

export {
  REVIEW_GRACE_MS,
  REVIEW_WINDOW_MS,
  graceEndsAt,
  reviewModeState,
  type ReviewModeColumns,
  type ReviewModeState,
} from '@feedbouncer/connectors';

/** Kinds that act on a comment or its author. Undo kinds (unhide, unban) stay automatic. */
export const GATED_KINDS: readonly ActionKind[] = Object.freeze([
  'hide',
  'delete',
  'ban_author',
  'public_reply',
  'private_reply',
] as const);
