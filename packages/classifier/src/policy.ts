import type { RuleAction } from '@feedbouncer/rules';
import {
  ACTION_SEVERITY,
  CATEGORIES,
  CATEGORY_PRIORITY,
  type Category,
  type CategoryScores,
  type ClassifierVerdict,
  type Downgrade,
  type ThresholdPolicy,
  type Trigger,
} from './types.js';

export const roundScore = (x: number): number => Math.round(x * 10_000) / 10_000;
export const roundScores = (s: CategoryScores): CategoryScores =>
  Object.fromEntries(CATEGORIES.map((c) => [c, roundScore(s[c])])) as Record<Category, number>;

const DESTRUCTIVE = new Set<RuleAction>(['hide', 'remove']);

export function decide(
  scores: CategoryScores,
  policy: ThresholdPolicy,
  signals: { lowSignal: boolean; languageSupported: boolean },
): ClassifierVerdict {
  const cap: Downgrade | null = signals.lowSignal
    ? 'low_signal'
    : signals.languageSupported
      ? null
      : 'unsupported_language';
  let downgraded: Downgrade | null = null;
  const triggers: Trigger[] = [];
  for (const c of CATEGORIES) {
    const { threshold, action } = policy[c];
    const score = scores[c];
    if (score < threshold) continue;
    const effectiveAction: RuleAction = cap !== null && DESTRUCTIVE.has(action) ? 'flag' : action;
    if (effectiveAction !== action) downgraded = cap;
    triggers.push({ category: c, score, threshold, action, effectiveAction });
  }
  if (triggers.length === 0)
    return { outcome: null, primary: null, triggers: [], downgraded: null };
  const primary = [...triggers].sort(
    (a, b) =>
      ACTION_SEVERITY[b.effectiveAction] - ACTION_SEVERITY[a.effectiveAction] ||
      b.score - b.threshold - (a.score - a.threshold) ||
      CATEGORY_PRIORITY.indexOf(a.category) - CATEGORY_PRIORITY.indexOf(b.category),
  )[0]!;
  return { outcome: primary.effectiveAction, primary, triggers, downgraded };
}
