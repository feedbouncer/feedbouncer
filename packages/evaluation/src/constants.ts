export const LOW_CONFIDENCE_N = 30;
export const LANGUAGE_MIN_N = 30;
export const MIN_LABELS_PER_ITEM = 2;
export const WILSON_Z = 1.96;

export const MAX_INPUT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_CSV_RECORD_BYTES = 64 * 1024;

export const REPORT_SCHEMA_VERSION = 1;
export const RUN_SCHEMA_VERSION = 1;

export const LABEL_CATEGORIES = [
  'scam',
  'spam_bot',
  'hate',
  'competitor',
  'profanity',
  'question',
  'complaint',
  'lead',
  'positive',
  'neutral',
] as const;

export const ITEM_ID_RE = /^i_[0-9a-f]{16}$/;
export const LABELLER_RE = /^[A-Za-z0-9_-]{1,32}$/;
