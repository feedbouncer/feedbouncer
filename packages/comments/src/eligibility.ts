// Whether a moderation action can apply to a stored comment, decided without
// asking the platform. The one copy of these rules: ModerationActions.request
// records its up-front outcomes from it, and the comments list shows the same
// answer as per-action availability. Platform differences come from the
// connector's `capabilities.constraints`; absent constraints mean Facebook's
// behaviour.
import {
  PRIVATE_REPLY_WINDOW_MS,
  type ConnectionStatus,
  type ConnectorCapabilities,
  type PlatformState,
  type ResponseKind,
} from '@feedbouncer/connectors';
import { ACTION_KINDS, AUTHOR_KINDS, type ActionActor, type ActionKind } from './actions.js';
import type { CommentRow } from './store.js';

/** The generic reply limit (replyTextSchema). */
const DEFAULT_MAX_REPLY_CHARS = 8000;

export interface ResolvedConstraints {
  readonly privateReplyWindowMs: number;
  readonly privateReplyTopLevelOnly: boolean;
  readonly publicReplyOnHidden: boolean;
  readonly hideOwnAccountComments: boolean;
  /** Code points. */
  readonly maxReplyChars: Readonly<Record<ResponseKind, number>>;
}

export function resolveConstraints(caps: ConnectorCapabilities): ResolvedConstraints {
  const k = caps.constraints ?? {};
  return {
    privateReplyWindowMs: k.privateReplyWindowMs ?? PRIVATE_REPLY_WINDOW_MS,
    privateReplyTopLevelOnly: k.privateReplyTopLevelOnly ?? false,
    publicReplyOnHidden: k.publicReplyOnHidden ?? true,
    hideOwnAccountComments: k.hideOwnAccountComments ?? true,
    maxReplyChars: {
      public_reply: k.maxReplyChars?.public_reply ?? DEFAULT_MAX_REPLY_CHARS,
      private_reply: k.maxReplyChars?.private_reply ?? DEFAULT_MAX_REPLY_CHARS,
    },
  };
}

export interface EligibilityComment {
  readonly platformState: 'visible' | 'hidden' | 'deleted';
  readonly isOwnAccount: boolean;
  readonly hasAuthor: boolean;
  readonly parentExternalId: string | null;
  readonly postedAt: Date;
  /** A private reply to this comment is pending or applied. */
  readonly privateReplied: boolean;
  /**
   * State of the comment a public reply is actually posted on. Threads are one
   * level deep, so a reply to a nested comment goes on its top-level parent and
   * this is the parent's state. Absent or null when that comment is not stored:
   * the comment's own state is used then.
   */
  readonly replyTargetPlatformState?: PlatformState | null;
}

/** Why nothing can be requested on a connection right now; null when it is active. */
export function connectionRefusal(
  status: ConnectionStatus,
): 'connection_needs_reconnect' | 'connection_inactive' | null {
  if (status === 'active') return null;
  return status === 'reconnect_required' ? 'connection_needs_reconnect' : 'connection_inactive';
}

/** The eligibility view of a stored comment. Actions and the comments list both use it, so they agree. */
export function eligibilityComment(row: CommentRow): EligibilityComment {
  return {
    platformState: row.platformState,
    isOwnAccount: row.isOwnAccount,
    hasAuthor: row.authorExternalId !== null,
    parentExternalId: row.parentExternalId,
    postedAt: row.postedAt,
    privateReplied: row.privateReplied,
    replyTargetPlatformState:
      row.parentExternalId !== null ? row.parentPlatformState : row.platformState,
  };
}

export type Eligibility =
  | { readonly verdict: 'ok' }
  | { readonly verdict: 'unsupported' }
  | {
      readonly verdict: 'noop';
      readonly code: 'already_deleted' | 'already_hidden' | 'already_visible';
    }
  | { readonly verdict: 'not_eligible'; readonly code: string };

/** The first rule that matches decides. */
export function evaluateEligibility({
  kind,
  actorType,
  comment: c,
  caps,
  now,
}: {
  kind: ActionKind;
  actorType: ActionActor['type'];
  comment: EligibilityComment;
  caps: ConnectorCapabilities;
  now: Date;
}): Eligibility {
  const supported: readonly string[] = [...caps.actions, ...(caps.responses ?? [])];
  if (!supported.includes(kind)) return { verdict: 'unsupported' };
  const k = resolveConstraints(caps);
  const no = (code: string): Eligibility => ({ verdict: 'not_eligible', code });
  const byAuthor = AUTHOR_KINDS.has(kind);

  // Bans are against the author, so a deleted comment does not make them moot.
  if (c.platformState === 'deleted' && !byAuthor)
    return { verdict: 'noop', code: 'already_deleted' };
  if (kind === 'hide' && c.platformState === 'hidden')
    return { verdict: 'noop', code: 'already_hidden' };
  if (kind === 'unhide' && c.platformState === 'visible')
    return { verdict: 'noop', code: 'already_visible' };
  if ((actorType === 'rule' || actorType === 'classifier') && c.isOwnAccount)
    return no('own_account_comment');
  if ((kind === 'hide' || kind === 'unhide') && c.isOwnAccount && !k.hideOwnAccountComments)
    return no('own_comment_always_visible');
  if (byAuthor && c.isOwnAccount) return no('author_is_page');
  if ((byAuthor || kind === 'private_reply') && !c.hasAuthor) return no('author_unavailable');
  if (
    kind === 'public_reply' &&
    (c.replyTargetPlatformState ?? c.platformState) === 'hidden' &&
    !k.publicReplyOnHidden
  )
    return no('reply_to_hidden_comment');
  if (kind === 'private_reply') {
    if (c.parentExternalId !== null && k.privateReplyTopLevelOnly)
      return no('private_reply_nested_comment');
    if (now.getTime() >= c.postedAt.getTime() + k.privateReplyWindowMs)
      return no('private_reply_window_closed');
    if (c.privateReplied) return no('private_reply_already_sent');
  }
  return { verdict: 'ok' };
}

export type ActionAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/** What a person may do with the comment right now, per action kind. */
export function availabilityFor(i: {
  comment: EligibilityComment;
  caps: ConnectorCapabilities;
  now: Date;
}): Readonly<Record<ActionKind, ActionAvailability>> {
  return Object.fromEntries(
    ACTION_KINDS.map((kind): [ActionKind, ActionAvailability] => {
      const e = evaluateEligibility({ ...i, kind, actorType: 'user' });
      if (e.verdict === 'ok') return [kind, { available: true }];
      return [
        kind,
        { available: false, reason: e.verdict === 'unsupported' ? 'unsupported' : e.code },
      ];
    }),
  ) as Record<ActionKind, ActionAvailability>;
}
