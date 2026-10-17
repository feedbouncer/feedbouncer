// The logic behind the review-mode banner, the suggestion queue and the early exit, kept free
// of React so it can be tested directly.
import {
  needsConfirmation,
  type GatedStep,
  type StepStatus,
  type StepType,
  type SuggestionStatus,
} from '@feedbouncer/actions/shared';
import type { BrandApiBase } from './actions';
import { ApiRequestError, apiFetch, type HandledDetails } from './api-client';
import { messageFor } from './messages';

export type ReviewModeState = 'off' | 'active' | 'ended' | 'ended_early' | 'opted_out';

/** A connection's review window (GET .../review-mode). Times are ISO UTC. */
export interface ReviewModeStatusDto {
  connectionId: string;
  platform: string;
  displayName: string | null;
  state: ReviewModeState;
  startedAt: string | null;
  endsAt: string | null;
  /** Set only when review mode was ended early. */
  endedAt: string | null;
  graceEndsAt: string | null;
  pendingCount: number;
}

export interface SuggestionSourceView {
  type: 'rule' | 'classifier' | 'policy';
  ruleId: string | null;
  ruleName: string | null;
  ruleLive: boolean;
  alsoMatched: { ruleId: string; ruleName: string }[];
  steps: GatedStep[];
  /** Render as text only. */
  reason: string;
  createdAt: string;
}

/** One suggestion (GET .../suggestions). Comment text and author name: render as text only. */
export interface SuggestionView {
  id: string;
  connectionId: string;
  platform: string;
  commentId: string;
  commentBody: string;
  authorId: string | null;
  authorName: string | null;
  authorPendingCount: number;
  status: SuggestionStatus;
  statusReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  expiresAt: string | null;
  sources: SuggestionSourceView[];
  plan: { steps: GatedStep[]; dropped: { type: StepType; reason: string }[] };
  execution: {
    runId: string;
    steps: { type: StepType; status: StepStatus; reason: string | null }[];
  } | null;
}

export interface PendingAuthor {
  authorId: string;
  authorName: string | null;
  pendingCount: number;
}

export interface QueueFilter {
  status?: SuggestionStatus | 'all' | undefined;
  connectionId?: string | undefined;
  ruleId?: string | undefined;
  authorId?: string | undefined;
  stepType?: GatedStep['type'] | undefined;
}

export type DecisionDto =
  | { status: 'approved'; runId: string; steps: StepType[] }
  | { status: 'dismissed' | 'expired' | 'withdrawn' }
  | { status: 'not_applicable'; reason: string }
  | { status: 'refused'; code: string };

export function formatLocal(iso: string, o: { timeZone?: string; locale?: string } = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // dateStyle 'medium' + timeStyle 'short' spelled out: the styles cannot be combined with timeZoneName.
  return new Intl.DateTimeFormat(o.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(o.timeZone !== undefined && { timeZone: o.timeZone }),
  }).format(d);
}

/** Full date and time to the second, for a tooltip. */
export function formatLocalExact(
  iso: string,
  o: { timeZone?: string; locale?: string } = {},
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(o.locale, {
    dateStyle: 'full',
    timeStyle: 'long',
    ...(o.timeZone !== undefined && { timeZone: o.timeZone }),
  }).format(d);
}

const accountName = (s: ReviewModeStatusDto): string => s.displayName ?? 'Unnamed account';

export function bannerText(s: ReviewModeStatusDto, fmt: (iso: string) => string): string | null {
  if (s.state === 'active' && s.endsAt !== null)
    return `Review mode is on for ${accountName(s)} until ${fmt(s.endsAt)}. FeedBouncer suggests actions but won't hide, delete, ban or reply on its own. ${s.pendingCount} suggestions are waiting for review.`;
  const endedAt = s.endedAt ?? s.endsAt;
  if (
    (s.state === 'ended' || s.state === 'ended_early') &&
    s.pendingCount > 0 &&
    endedAt !== null &&
    s.graceEndsAt !== null
  )
    return `Review mode ended on ${fmt(endedAt)}. Rules now run automatically. ${s.pendingCount} suggestions from review mode were not run and will expire on ${fmt(s.graceEndsAt)} unless you review them.`;
  return null;
}

const decidedBy = (
  s: Pick<SuggestionView, 'decidedAt' | 'decidedByName'>,
  fmt: (iso: string) => string,
) => `${s.decidedByName ?? 'a team member'}${s.decidedAt ? ` at ${fmt(s.decidedAt)}` : ''}`;

const EXPIRED_TEXT =
  'Expired: not reviewed within 72 hours after review mode ended. Nothing was run.';
const WITHDRAWN_TEXT = 'Withdrawn: the rule behind this suggestion was changed or turned off.';

export function suggestionStatusText(s: SuggestionView, fmt: (iso: string) => string): string {
  switch (s.status) {
    case 'pending':
      return 'Waiting for review.';
    case 'approved':
      return `Approved by ${decidedBy(s, fmt)}.`;
    case 'dismissed':
      return s.statusReason === 'review_mode_ended'
        ? `Dismissed by ${decidedBy(s, fmt)} when review mode was ended early.`
        : `Dismissed by ${decidedBy(s, fmt)}.`;
    case 'expired':
      return EXPIRED_TEXT;
    case 'not_applicable':
      return s.statusReason === 'comment_edited'
        ? 'No longer applicable: the comment was edited after this suggestion was made.'
        : 'No longer applicable: the comment was deleted.';
    case 'withdrawn':
      return WITHDRAWN_TEXT;
  }
}

export function handledText(h: HandledDetails, fmt: (iso: string) => string): string {
  switch (h.status) {
    case 'expired':
      return EXPIRED_TEXT;
    case 'withdrawn':
      return WITHDRAWN_TEXT;
    case 'not_applicable':
      return 'No longer applicable: the comment was deleted or edited after this suggestion was made.';
    default:
      return `Already handled by ${decidedBy(h, fmt)}.`;
  }
}

/** What to show for a failed decision. An already-handled suggestion is news, not an error. */
export function decisionErrorText(
  err: unknown,
  fmt: (iso: string) => string,
): { handled: boolean; text: string } {
  if (!(err instanceof ApiRequestError)) return { handled: false, text: 'Something went wrong.' };
  if (err.code === 'suggestion_already_handled')
    return {
      handled: true,
      text: err.handled ? handledText(err.handled, fmt) : messageFor(err.code),
    };
  return { handled: false, text: messageFor(err.code) };
}

export type Decision = 'approve' | 'dismiss';

export interface PendingDecision {
  suggestionId: string;
  action: Decision;
  /** Approving a plan with delete or ban needs an explicit confirmation. */
  confirm: boolean;
  /** Made once, so a double click or a retry is one decision. */
  requestKey: string;
}

export const openDecision = (
  s: Pick<SuggestionView, 'id' | 'plan'>,
  action: Decision,
): PendingDecision => ({
  suggestionId: s.id,
  action,
  confirm: action === 'approve' && needsConfirmation(s.plan.steps),
  requestKey: crypto.randomUUID(),
});

export const decide = (base: BrandApiBase, d: PendingDecision) =>
  apiFetch<DecisionDto>(`${base}/suggestions/${d.suggestionId}/${d.action}`, {
    method: 'POST',
    body: { requestKey: d.requestKey, ...(d.confirm && { confirm: true }) },
  });

export const bulkByIds = (
  base: BrandApiBase,
  action: Decision,
  ids: string[],
  requestKey: string,
  confirm: boolean,
) =>
  apiFetch<{ results: { id: string; result: DecisionDto }[] }>(`${base}/suggestions/bulk`, {
    method: 'POST',
    body: { action, ids, requestKey, ...(confirm && { confirm: true }) },
  });

/** Every pending suggestion for one author; approving may run deletes and bans, so it confirms. */
export const bulkByAuthor = (
  base: BrandApiBase,
  action: Decision,
  connectionId: string,
  authorId: string,
  requestKey: string,
) =>
  apiFetch<{ matched: number }>(`${base}/suggestions/bulk`, {
    method: 'POST',
    body: {
      action,
      connectionId,
      filter: { authorId },
      requestKey,
      ...(action === 'approve' && { confirm: true }),
    },
  });

/** Runs `fn` unless a previous call is still running. */
export function singleFlight<A extends unknown[]>(
  fn: (...a: A) => Promise<void>,
): (...a: A) => Promise<void> {
  let running = false;
  return async (...a) => {
    if (running) return;
    running = true;
    try {
      await fn(...a);
    } finally {
      running = false;
    }
  };
}

export type EndChoice = 'leave' | 'dismiss' | 'approve';

export const END_CHOICES: readonly { value: EndChoice; label: string }[] = [
  { value: 'leave', label: 'Leave them waiting (they expire 72 hours after review mode ends)' },
  { value: 'dismiss', label: 'Dismiss all' },
  {
    value: 'approve',
    label: 'Approve all (runs every suggested action, including deletes and bans)',
  },
];

/** The early-exit request body, or null while "Approve all" is not confirmed. */
export function endReviewModeBody(
  choice: EndChoice,
  confirmed: boolean,
): { pending: EndChoice; confirm?: true } | null {
  if (choice !== 'approve') return { pending: choice };
  return confirmed ? { pending: choice, confirm: true } : null;
}

export const endReviewMode = (base: BrandApiBase, connectionId: string, body: object) =>
  apiFetch<{ status: 'ended'; pendingCount: number }>(
    `${base}/connections/${connectionId}/review-mode/end`,
    { method: 'POST', body },
  );

/** The queue URL for a filter; empty values are left out. */
export function queueHref(orgId: string, brandId: string, f: QueueFilter & { before?: string }) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (typeof v === 'string' && v !== '') q.set(k, v);
  const s = q.toString();
  return `/orgs/${orgId}/brands/${brandId}/suggestions${s ? `?${s}` : ''}`;
}
