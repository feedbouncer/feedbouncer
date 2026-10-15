import type { RuleAction } from '@feedbouncer/rules';

export const CATEGORIES = [
  'spam',
  'scam_phishing',
  'harassment_abuse',
  'hate_speech',
  'sexual_content',
  'profanity',
  'self_promotion',
] as const;
export type Category = (typeof CATEGORIES)[number];
export type CategoryScores = Readonly<Record<Category, number>>;

/** remove > hide > flag > approve */
export const ACTION_SEVERITY: Readonly<Record<RuleAction, number>> = {
  approve: 0,
  flag: 1,
  hide: 2,
  remove: 3,
};
/** Tie-break when two triggers have the same action and margin: earlier wins. */
export const CATEGORY_PRIORITY: readonly Category[] = [
  'hate_speech',
  'scam_phishing',
  'harassment_abuse',
  'sexual_content',
  'spam',
  'self_promotion',
  'profanity',
];

export interface CategoryThreshold {
  readonly category: Category;
  readonly threshold: number;
  readonly action: RuleAction;
  readonly source: 'default' | 'brand';
}
export type ThresholdPolicy = Readonly<Record<Category, CategoryThreshold>>;

export interface Trigger {
  readonly category: Category;
  readonly score: number;
  readonly threshold: number;
  /** As configured. */
  readonly action: RuleAction;
  /** After low-signal / unsupported-language downgrade. */
  readonly effectiveAction: RuleAction;
}
export type Downgrade = 'low_signal' | 'unsupported_language';
export interface ClassifierVerdict {
  readonly outcome: RuleAction | null;
  readonly primary: Trigger | null;
  readonly triggers: readonly Trigger[];
  readonly downgraded: Downgrade | null;
}

export const CLASSIFICATION_STATUSES = ['classified', 'unclassified', 'skipped'] as const;
export type ClassificationStatus = (typeof CLASSIFICATION_STATUSES)[number];
export const UNCLASSIFIED_REASONS = [
  'timeout',
  'rate_limited',
  'unavailable',
  'auth',
  'invalid_output',
  'bad_request',
  'disabled',
  'queue_timeout',
] as const;
export type UnclassifiedReason = (typeof UNCLASSIFIED_REASONS)[number];
export const CLASSIFICATION_SKIP_REASONS = [
  'deleted',
  'own_account',
  'rules_not_evaluated',
] as const;
export type ClassificationSkipReason = (typeof CLASSIFICATION_SKIP_REASONS)[number];

export interface PreparedInput {
  /** What is sent to the model (possibly truncated). */
  readonly text: string;
  /** No visible characters at all: not sent to the model. */
  readonly empty: boolean;
  /** Emoji-only or fewer than 3 letters/digits: results never trigger hide/remove. */
  readonly lowSignal: boolean;
  readonly truncated: boolean;
  /** Original length in UTF-16 code units. */
  readonly inputChars: number;
}
