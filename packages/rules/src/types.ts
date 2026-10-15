import type { Platform } from '@feedbouncer/connectors';

export const RULE_ACTIONS = ['approve', 'flag', 'hide', 'remove'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
/** remove > hide > flag > approve */
export const ACTION_SEVERITY: Readonly<Record<RuleAction, number>> = {
  approve: 0,
  flag: 1,
  hide: 2,
  remove: 3,
};
export const RULE_MODES = ['enforce', 'suggest'] as const;
export type RuleMode = (typeof RULE_MODES)[number];
export const RULE_KINDS = [
  'keyword',
  'regex',
  'link_domain',
  'emoji',
  'author',
  'competitor',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** A rule row as loaded from Postgres; `conditions` is unvalidated JSON until compiled. */
export interface RuleRecord {
  id: string;
  name: string;
  conditions: unknown;
  action: RuleAction;
  mode: RuleMode;
  priority: number;
  enabled: boolean;
  createdAt: Date;
}

export interface CommentFacts {
  body: string;
  platform: Platform;
  authorExternalId: string | null;
  authorName: string | null;
}

export interface BrandContext {
  /** ASCII (punycode) lower-case registrable or full host names, e.g. "example.com". */
  ownDomains: readonly string[];
}

export type Evidence =
  | { kind: 'keyword'; term: string }
  | { kind: 'regex'; patternIndex: number }
  | {
      kind: 'link';
      host: string;
      reason: 'blocklisted' | 'not_allowlisted' | 'shortener' | 'lookalike';
    }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'emoji_count'; count: number; max: number }
  | { kind: 'author'; list: 'block' | 'allow' | 'trusted'; matchedOn: 'id' | 'handle' }
  | { kind: 'competitor'; term: string; via: 'name' | 'handle' | 'domain' };

export type SkipReason = 'timeout' | 'invalid_conditions' | 'error';

export interface TraceEntry {
  ruleId: string;
  mode: RuleMode;
  result: 'match' | 'no_match' | 'skipped';
  skipReason?: SkipReason;
  evidence?: Evidence;
}

export interface RuleHit {
  ruleId: string;
  ruleName: string;
  kind: RuleKind;
  action: RuleAction;
  evidence: Evidence;
}

export interface Verdict {
  /** First enforcing match, or null. */
  decided: RuleHit | null;
  /** Dry-run matches seen before the decision point, in order. */
  suggestions: RuleHit[];
  trace: TraceEntry[];
}
