import type { ReplyTarget } from '@feedbouncer/actions';
import { connectionRefusal, evaluateEligibility, resolveConstraints } from '@feedbouncer/comments';
import type { ConnectorCapabilities } from '@feedbouncer/connectors';

export type ReplyAvailability =
  | { available: true; maxChars: number }
  | { available: false; reason: string };

/**
 * Whether the caller can post a public reply to a listed comment now. The first match decides:
 * permission, the connection's state, platform support, the comment's eligibility, else the
 * platform's limit. Listed comments are visible and never the page's own.
 */
export function replyAvailability(i: {
  permitted: boolean;
  target: ReplyTarget;
  postedAt: Date;
  caps: ConnectorCapabilities | undefined;
  now: Date;
}): ReplyAvailability {
  const no = (reason: string): ReplyAvailability => ({ available: false, reason });
  if (!i.permitted) return no('not_permitted');
  const blocked = connectionRefusal(i.target.connectionStatus);
  if (blocked) return no(blocked);
  if (!i.caps) return no('unsupported');
  const supported: readonly string[] = i.caps.responses ?? i.caps.actions;
  if (!supported.includes('public_reply')) return no('unsupported');
  const t = i.target;
  // A reply to a nested comment goes on its parent. A parent we have not stored may be hidden.
  const targetState = t.targetPlatformState ?? (t.parentExternalId !== null ? 'hidden' : 'visible');
  if (targetState === 'deleted') return no('comment_gone');
  const e = evaluateEligibility({
    kind: 'public_reply',
    actorType: 'user',
    comment: {
      platformState: 'visible',
      isOwnAccount: false,
      hasAuthor: t.hasAuthor,
      parentExternalId: t.parentExternalId,
      postedAt: i.postedAt,
      privateReplied: false,
      replyTargetPlatformState: targetState,
    },
    caps: i.caps,
    now: i.now,
  });
  if (e.verdict === 'unsupported') return no('unsupported');
  if (e.verdict !== 'ok') return no(e.code);
  return { available: true, maxChars: resolveConstraints(i.caps).maxReplyChars.public_reply };
}
