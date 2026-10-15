export const POLICY_ACTIONS = ['flag', 'hide', 'remove'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];
export const POLICY_VERDICTS = ['clear_match', 'possible_match', 'no_match'] as const;
export type PolicyVerdict = (typeof POLICY_VERDICTS)[number];

export interface ActivePolicy {
  readonly policyId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly name: string;
  readonly text: string;
  readonly action: PolicyAction;
}
export type Downgrade = 'low_confidence' | 'low_signal' | 'moderator_acted';
export interface PolicyMatch {
  readonly policyId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly name: string;
  readonly confidence: 'high' | 'low';
  readonly action: PolicyAction;
  readonly effectiveAction: PolicyAction;
  readonly downgrade: Downgrade | null;
}
export interface PolicyDecision {
  readonly outcome: PolicyAction | null;
  readonly winner: PolicyMatch | null;
  readonly matches: readonly PolicyMatch[];
}

export const EVALUATION_STATUSES = ['evaluated', 'failed', 'skipped'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];
export const SKIP_REASONS = [
  'deleted',
  'own_account',
  'rules_not_evaluated',
  'rule_decided',
  'quota_exhausted',
  'policy_changed',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
/** ProviderErrorCode from @feedbouncer/ai plus queue_timeout. */
export const FAILURE_CODES = [
  'timeout',
  'rate_limited',
  'unavailable',
  'auth',
  'invalid_output',
  'bad_request',
  'disabled',
  'queue_timeout',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export const MAX_POLICIES_PER_BRAND = 20;
export const MAX_ENABLED_POLICIES_PER_BRAND = 10;
export const MIN_POLICY_CHARS = 8;
export const MAX_POLICY_CHARS = 500;
export const MAX_NAME_CHARS = 80;
export const PREVIEW_MAX_COMMENTS = 200;
export const PREVIEW_MAX_DAYS = 14;
export const PREVIEW_RETENTION_DAYS = 7;
/** A preview still running after this long has lost its jobs; the next preview replaces it. */
export const PREVIEW_STALE_MINUTES = 120;
export const RUN_MAX_DAYS = 7;
export const RUN_MAX_COMMENTS_PER_CONNECTION = 500;
export const RUN_MIN_INTERVAL_MINUTES = 15;
