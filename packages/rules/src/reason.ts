import type { StepType } from '@feedbouncer/actions';
import type { Platform } from '@feedbouncer/connectors';
import type { Evidence, RuleHit, RuleKind } from './types.js';

const MAX_REASON_CHARS = 2000;

const KIND_LABEL: Record<RuleKind, string> = {
  keyword: 'keyword',
  regex: 'regex',
  link_domain: 'link domain',
  emoji: 'emoji',
  author: 'author',
  competitor: 'competitor',
};

const LINK_REASON: Record<Extract<Evidence, { kind: 'link' }>['reason'], string> = {
  blocklisted: 'is blocklisted',
  not_allowlisted: 'is not on the allowlist',
  shortener: 'is a URL shortener',
  lookalike: 'looks like a disguised domain',
};

function evidenceText(e: Evidence): string {
  switch (e.kind) {
    case 'keyword':
      return `matched "${e.term}"`;
    case 'regex':
      return `matched pattern #${e.patternIndex + 1}`;
    case 'link':
      return `link to ${e.host} ${LINK_REASON[e.reason]}`;
    case 'emoji':
      return `contains ${e.emoji}`;
    case 'emoji_count':
      return `has ${e.count} emoji (max ${e.max})`;
    case 'author':
      return `author is on the ${e.list} list (matched by ${e.matchedOn === 'id' ? 'account ID' : 'handle'})`;
    case 'competitor':
      return `mentions competitor "${e.term}"`;
  }
}

const clip = (s: string) => (s.length > MAX_REASON_CHARS ? s.slice(0, MAX_REASON_CHARS) : s);

export function describeDecision(hit: RuleHit): string {
  const label = KIND_LABEL[hit.kind] ?? hit.kind;
  return clip(`Rule "${hit.ruleName}" (${label}): ${evidenceText(hit.evidence)}.`);
}

const FALLBACK_TEXT: Record<string, string> = {
  unsupported: 'does not allow it',
  action_not_supported: 'does not allow it',
  missing_permission: 'FeedBouncer lacks the permission for it',
  connection_needs_reconnect: 'the connection needs reconnecting',
  connection_inactive: 'the connection is disconnected',
  rate_limited: 'the platform is rate-limiting us (still retrying)',
  permission_revoked: 'permission was revoked',
  auth_expired: 'permission was revoked',
};

const PLATFORM_LABEL: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  tiktok_ads: 'TikTok ads',
  threads: 'Threads',
};

const VERB: Record<'hide' | 'remove' | Exclude<StepType, 'flag_for_review'>, string> = {
  hide: 'hide this comment',
  remove: 'delete this comment',
  delete: 'delete this comment',
  ban: 'ban the author of this comment',
  auto_reply: 'reply to this comment',
  private_reply: 'reply privately to this comment',
};

/** `code` may carry detail after a colon, e.g. `action_not_supported:tiktok:delete`. */
export function describeFallback(
  ruleName: string,
  action: keyof typeof VERB,
  code: string,
  platform: Platform,
): string {
  const base = code.split(':', 1)[0]!;
  const known = Object.hasOwn(FALLBACK_TEXT, base);
  const why = known ? FALLBACK_TEXT[base]! : 'the platform call failed';
  const plat = Object.hasOwn(PLATFORM_LABEL, platform)
    ? PLATFORM_LABEL[platform]!
    : String(platform);
  // Platform name leads only for the "does not allow it" reading.
  const reason = why === FALLBACK_TEXT.unsupported ? `${plat} ${why}` : why;
  const tail = `" wanted to ${VERB[action]}, but ${reason} (${code}). Flagged for review instead.`;
  // Only the rule name is shortened, so the reason in parentheses always survives.
  const name = ruleName.slice(0, Math.max(0, MAX_REASON_CHARS - 'Rule "'.length - tail.length));
  return clip(`Rule "${name}${tail}`);
}
