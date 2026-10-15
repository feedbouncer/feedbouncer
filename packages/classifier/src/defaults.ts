import type { RuleAction } from '@feedbouncer/rules';
import type { ThresholdItem } from './settings.js';
import { CATEGORIES, type Category, type CategoryScores, type ThresholdPolicy } from './types.js';

const SEVERE = new Set<Category>(['hate_speech', 'scam_phishing']);
export const DEFAULT_THRESHOLDS: ThresholdPolicy = Object.freeze(
  Object.fromEntries(
    CATEGORIES.map((c) => [
      c,
      Object.freeze({
        category: c,
        threshold: 0.8,
        action: SEVERE.has(c) ? 'hide' : 'flag',
        source: 'default' as const,
      }),
    ]),
  ) as unknown as ThresholdPolicy,
);
export const ZERO_SCORES: CategoryScores = Object.freeze(
  Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>,
);

const isCategory = (s: string): s is Category => (CATEGORIES as readonly string[]).includes(s);

export function resolvePolicy(
  rows: ReadonlyArray<{ category: string; threshold: number; action: RuleAction }>,
): ThresholdPolicy {
  const out: Record<string, ThresholdPolicy[Category]> = { ...DEFAULT_THRESHOLDS };
  for (const r of rows) {
    if (!isCategory(r.category)) continue;
    out[r.category] = {
      category: r.category,
      threshold: r.threshold,
      action: r.action,
      source: 'brand',
    };
  }
  return out as unknown as ThresholdPolicy;
}

/** The policy that results from applying update items: useDefault restores the default. */
export function applyItems(
  policy: ThresholdPolicy,
  items: readonly ThresholdItem[],
): ThresholdPolicy {
  const out: Record<Category, ThresholdPolicy[Category]> = { ...policy };
  for (const it of items) {
    out[it.category] =
      'useDefault' in it
        ? DEFAULT_THRESHOLDS[it.category]
        : { category: it.category, threshold: it.threshold, action: it.action, source: 'brand' };
  }
  return out;
}
