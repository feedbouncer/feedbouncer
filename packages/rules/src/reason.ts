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
  connection_needs_reconnect: 'the connection needs reconnecting',
  connection_inactive: 'the connection is disconnected',
  rate_limited: 'the platform is rate-limiting us (still retrying)',
  permission_revoked: 'permission was revoked',
  auth_expired: 'permission was revoked',
};

const PLATFORM_LABEL: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram' };

export function describeFallback(
  ruleName: string,
  action: 'hide' | 'remove',
  code: string,
  platform: Platform,
): string {
  const verb = action === 'remove' ? 'delete' : 'hide';
  const known = Object.hasOwn(FALLBACK_TEXT, code);
  const why = known ? FALLBACK_TEXT[code]! : 'the platform call failed';
  const plat = Object.hasOwn(PLATFORM_LABEL, platform)
    ? PLATFORM_LABEL[platform]!
    : String(platform);
  // Platform name leads only for the "does not allow it" reading.
  const reason = code === 'unsupported' ? `${plat} ${why}` : why;
  return clip(
    `Rule "${ruleName}" wanted to ${verb} this comment, but ${reason} (${code}). Flagged for review instead.`,
  );
}
