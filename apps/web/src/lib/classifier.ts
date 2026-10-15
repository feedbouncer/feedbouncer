import { ACTION_LABEL, RULE_ACTIONS, type RuleAction } from './rules';

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

export const CATEGORY_LABEL: Record<Category, string> = {
  spam: 'Spam',
  scam_phishing: 'Scam or phishing',
  harassment_abuse: 'Harassment or abuse',
  hate_speech: 'Hate speech',
  sexual_content: 'Sexual content',
  profanity: 'Profanity',
  self_promotion: 'Self-promotion',
};

export interface Trigger {
  category: Category;
  score: number;
  threshold: number;
  action: RuleAction;
  effectiveAction: RuleAction;
}

export interface ClassifierEvidence {
  category: Category;
  score: number;
  threshold: number;
  provider: string | null;
  model: string | null;
  triggers: Trigger[];
  downgraded: 'low_signal' | 'unsupported_language' | null;
  reversal: boolean;
}

export interface ThresholdView {
  category: Category;
  threshold: number;
  action: RuleAction;
  source: 'default' | 'brand';
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null } | null;
}

export interface ClassifierSettings {
  provider: { id: string | null; model: string | null; enabled: boolean };
  categories: ThresholdView[];
}

export interface PreviewResult {
  window: { from: string; to: string };
  examined: number;
  changed: number;
  transitions: Record<string, number>;
  samples: { commentId: string; before: RuleAction | null; after: RuleAction | null }[];
  capped: boolean;
}

export interface ClassificationView {
  id: string;
  status: 'classified' | 'unclassified' | 'skipped';
  skipReason: string | null;
  unclassifiedReason: string | null;
  provider: string | null;
  model: string | null;
  scores: Record<Category, number> | null;
  language: string | null;
  languageSupported: boolean | null;
  lowSignal: boolean;
  truncated: boolean;
  inputChars: number;
  ruleDecided: boolean;
  outcome: RuleAction | null;
  triggers: Trigger[];
  downgraded: 'low_signal' | 'unsupported_language' | null;
  createdAt: string;
}

export const formatScore = (x: number): string => x.toFixed(2);

export function classifierEvidence(c: {
  category: Category;
  score: number;
  threshold: number;
}): string {
  const cmp = c.score >= c.threshold ? '≥' : '<';
  return `${CATEGORY_LABEL[c.category]} ${formatScore(c.score)} ${cmp} ${formatScore(c.threshold)}`;
}

const UNCLASSIFIED_TEXT: Record<string, string> = {
  timeout: 'the classifier timed out',
  rate_limited: 'the classifier was rate-limited',
  unavailable: 'the classifier was unavailable',
  auth: 'the classifier credentials were rejected',
  invalid_output: 'the classifier returned an invalid result',
  bad_request: 'the classifier rejected the request',
  disabled: 'no classifier is configured',
  queue_timeout: 'it waited too long in the queue',
};

const SKIP_TEXT: Record<string, string> = {
  deleted: 'comment was deleted',
  own_account: "it's from your own account",
  rules_not_evaluated: 'rules never ran on it (imported history)',
};

const own = (table: Record<string, string>, key: string | null): string | undefined =>
  key !== null && Object.hasOwn(table, key) ? table[key] : undefined;

export function classificationStatusText(v: ClassificationView | null): string {
  if (!v) return 'Not classified yet';
  if (v.status === 'unclassified')
    return `Not classified: ${own(UNCLASSIFIED_TEXT, v.unclassifiedReason) ?? 'unknown error'}`;
  if (v.status === 'skipped') return `Not classified: ${own(SKIP_TEXT, v.skipReason) ?? 'skipped'}`;
  if (v.languageSupported === false)
    return `Classified (language not supported: ${v.language ?? 'unknown'}), destructive actions disabled`;
  return 'Classified';
}

const outcomeLabel = (o: string): string =>
  o === 'none' ? 'Not actioned' : (ACTION_LABEL[o as RuleAction] ?? o);

/** A preview transition key such as `none→hide` as "Not actioned → Hide". */
export function transitionText(key: string): string {
  const [before = 'none', after = 'none'] = key.split('→');
  return `${outcomeLabel(before)} → ${outcomeLabel(after)}`;
}

export type ThresholdItem =
  | { category: Category; threshold: number; action: RuleAction }
  | { category: Category; useDefault: true };

export interface ThresholdEdit {
  threshold: string;
  action: RuleAction;
  useDefault: boolean;
}

export const editOf = (v: ThresholdView): ThresholdEdit => ({
  threshold: String(v.threshold),
  action: v.action,
  useDefault: false,
});

function parseThreshold(text: string): { value: number } | { error: string } {
  const t = text.trim();
  const n = t === '' ? Number.NaN : Number(t);
  if (!Number.isFinite(n)) return { error: 'Threshold must be a number between 0 and 1.' };
  if (n < 0 || n > 1) return { error: 'Threshold must be between 0 and 1.' };
  if (Math.round(n * 10_000) / 10_000 !== n)
    return { error: 'Threshold can have at most 4 decimal places.' };
  return { value: n };
}

/** The request items for the categories that changed, or the per-category problems. */
export function buildThresholdUpdate(
  original: readonly ThresholdView[],
  edits: Partial<Record<Category, ThresholdEdit>>,
): { items: ThresholdItem[]; errors: Partial<Record<Category, string>> } {
  const items: ThresholdItem[] = [];
  const errors: Partial<Record<Category, string>> = {};
  for (const o of original) {
    const e = edits[o.category];
    if (!e || !RULE_ACTIONS.includes(e.action)) continue;
    if (e.useDefault) {
      if (o.source === 'brand') items.push({ category: o.category, useDefault: true });
      continue;
    }
    const parsed = parseThreshold(e.threshold);
    if ('error' in parsed) {
      errors[o.category] = parsed.error;
      continue;
    }
    if (parsed.value !== o.threshold || e.action !== o.action)
      items.push({ category: o.category, threshold: parsed.value, action: e.action });
  }
  return { items, errors };
}
