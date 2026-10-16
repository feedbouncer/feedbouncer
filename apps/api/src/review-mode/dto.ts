import type { DecisionResult, SuggestionView } from '@feedbouncer/actions';
import {
  graceEndsAt,
  reviewModeState,
  type Platform,
  type ReviewModeColumns,
  type ReviewModeState,
} from '@feedbouncer/connectors';
import type { HandledDetails } from '../http/errors.js';

/** A connection's review window. Times are ISO UTC. */
export interface ReviewModeStatusDto {
  connectionId: string;
  platform: Platform;
  displayName: string | null;
  state: ReviewModeState;
  startedAt: string | null;
  endsAt: string | null;
  endedAt: string | null;
  graceEndsAt: string | null;
  pendingCount: number;
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export function toReviewModeStatusDto(
  c: { id: string; platform: Platform; displayName: string | null; review: ReviewModeColumns },
  pendingCount: number,
  now: Date,
): ReviewModeStatusDto {
  return {
    connectionId: c.id,
    platform: c.platform,
    displayName: c.displayName,
    state: reviewModeState(c.review, now),
    startedAt: iso(c.review.startedAt),
    endsAt: iso(c.review.endsAt),
    endedAt: iso(c.review.endedAt),
    graceEndsAt: iso(graceEndsAt(c.review)),
    pendingCount,
  };
}

/** A suggestion as the queue shows it. Comment text, author and reasons are shown as text only, never logged. */
export type SuggestionDto = Omit<
  SuggestionView,
  'createdAt' | 'decidedAt' | 'expiresAt' | 'sources'
> & {
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  sources: (Omit<SuggestionView['sources'][number], 'createdAt'> & { createdAt: string })[];
};

export const toSuggestionDto = (s: SuggestionView): SuggestionDto => ({
  ...s,
  createdAt: s.createdAt.toISOString(),
  decidedAt: iso(s.decidedAt),
  expiresAt: iso(s.expiresAt),
  sources: s.sources.map((src) => ({ ...src, createdAt: src.createdAt.toISOString() })),
});

export type DecisionDto =
  | Exclude<DecisionResult, { code: 'already_handled' }>
  | { status: 'refused'; code: 'already_handled'; handled: HandledDetails };

export const toHandledDetails = (
  h: Extract<DecisionResult, { code: 'already_handled' }>['handled'],
): HandledDetails => ({ ...h, decidedAt: iso(h.decidedAt) });

export const toDecisionDto = (r: DecisionResult): DecisionDto =>
  r.status === 'refused' && r.code === 'already_handled'
    ? { ...r, handled: toHandledDetails(r.handled) }
    : r;
