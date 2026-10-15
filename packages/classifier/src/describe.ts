import type { RuleAction } from '@feedbouncer/rules';
import { MAX_INPUT_CHARS } from './prepare.js';
import type { Category, ClassifierVerdict, Trigger } from './types.js';

export const CATEGORY_TEXT: Readonly<Record<Category, string>> = {
  spam: 'Spam',
  scam_phishing: 'Scam or phishing',
  harassment_abuse: 'Harassment or abuse',
  hate_speech: 'Hate speech',
  sexual_content: 'Sexual content',
  profanity: 'Profanity',
  self_promotion: 'Self-promotion',
};
const ACTION_TEXT: Readonly<Record<RuleAction, string>> = {
  approve: 'Allow',
  flag: 'Flag for review',
  hide: 'Hide',
  remove: 'Delete',
};
const n = (x: number) => x.toFixed(2);
const evidence = (t: Trigger) => `${CATEGORY_TEXT[t.category]} ${n(t.score)} ≥ ${n(t.threshold)}`;

export function describeClassification(v: ClassifierVerdict, o: { truncated: boolean }): string {
  if (!v.primary) return 'Classifier: no category met its threshold.';
  const parts = [`Classifier: ${evidence(v.primary)} → ${ACTION_TEXT[v.primary.effectiveAction]}.`];
  const others = v.triggers.filter((t) => t !== v.primary);
  if (others.length > 0) {
    parts.push(
      `Also triggered: ${others.map((t) => `${evidence(t)} (${ACTION_TEXT[t.effectiveAction]})`).join('; ')}.`,
    );
  }
  if (v.downgraded !== null && v.primary.action !== v.primary.effectiveAction) {
    const why =
      v.downgraded === 'low_signal' ? 'very short or emoji-only text' : 'language not supported';
    parts.push(`${ACTION_TEXT[v.primary.action]} downgraded to Flag for review: ${why}.`);
  }
  if (o.truncated) {
    parts.push(
      `Only the first ${MAX_INPUT_CHARS.toLocaleString('en-US')} characters were classified.`,
    );
  }
  return parts.join(' ').slice(0, 2000);
}

export function describeFallback(kind: 'hide' | 'delete' | 'unhide', code: string): string {
  return `Flagged for review: the classifier couldn't ${kind} this comment (${code}).`;
}

export function describeReversal(category: Category, score: number, threshold: number): string {
  if (score < threshold)
    return `Unhidden: ${CATEGORY_TEXT[category]} now scores ${n(score)}, below ${n(threshold)}.`;
  return `Unhidden: ${CATEGORY_TEXT[category]} scores ${n(score)}, and the current settings (threshold ${n(threshold)}) no longer hide it.`;
}

export const MODERATOR_ACTED_NOTE =
  'A moderator already acted on this comment, so it is flagged for review instead of being hidden or deleted again.';
