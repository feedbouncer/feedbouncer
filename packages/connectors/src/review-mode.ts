// Review mode: for the first 168 hours after a connection is set up, automation
// only suggests. Pure state derived from the connection's review columns; the
// window is stamped on first activation (ConnectionDirectory.activate).

/** The review window: 168 hours. */
export const REVIEW_WINDOW_MS = 604_800_000;
/** How long suggestions stay decidable after the window ends: 72 hours. */
export const REVIEW_GRACE_MS = 259_200_000;

export type ReviewMode = 'legacy' | 'on' | 'opted_out';

export interface ReviewModeColumns {
  mode: ReviewMode;
  startedAt: Date | null;
  endsAt: Date | null;
  endedAt: Date | null;
}

export type ReviewModeState = 'off' | 'active' | 'ended' | 'ended_early' | 'opted_out';

/**
 * 'legacy' rows (connected before review mode existed) are never gated. An 'on'
 * row not activated yet has no start and counts as active. The window is
 * half-open: active before `endsAt`, ended from it.
 */
export function reviewModeState(c: ReviewModeColumns, now: Date): ReviewModeState {
  if (c.mode === 'legacy') return 'off';
  if (c.mode === 'opted_out') return 'opted_out';
  if (c.endedAt) return 'ended_early';
  if (!c.startedAt || !c.endsAt || now.getTime() < c.endsAt.getTime()) return 'active';
  return 'ended';
}

/** When suggestions from this window stop being decidable; null for off, opted out or a window never started. */
export function graceEndsAt(c: ReviewModeColumns): Date | null {
  if (c.mode !== 'on' || !c.startedAt) return null;
  const end = c.endedAt ?? c.endsAt;
  return end ? new Date(end.getTime() + REVIEW_GRACE_MS) : null;
}
