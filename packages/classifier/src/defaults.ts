import type { RuleAction } from '@feedbouncer/rules';
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
