/** At most this many UTF-16 code units; equals what the classifier reads, so nothing is truncated. */
export const MAX_CHECK_TEXT_UNITS = 4_000;

export const REASON_CODES = [
  'rule_matched',
  'classifier_threshold',
  'policy_matched',
  'no_match',
  'classifier_unavailable',
  'classifier_not_configured',
  'policy_unavailable',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
