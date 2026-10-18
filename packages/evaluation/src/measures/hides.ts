import { LANGUAGE_MIN_N } from '../constants.js';
import type { GroundTruth } from '../ground-truth.js';
import type { EvalItem } from '../schema.js';
import { rate, type Rate } from '../stats.js';

export type Cohort = 'automatic' | 'review';
export type Breakdown = { key: string; rate: Rate }[];

type Judged = { item: EvalItem; verdict: 'should_hide' | 'should_stay'; category: string };

function judged(items: readonly EvalItem[], gt: GroundTruth, cohort: Cohort): Judged[] {
  const out: Judged[] = [];
  for (const item of items) {
    const v = gt.verdicts.get(item.item);
    if (item.cohort === cohort && item.judgedVersionAvailable && v) out.push({ item, ...v });
  }
  return out;
}

function breakdown(
  rows: readonly Judged[],
  keyOf: (j: Judged) => string,
  isK: (j: Judged) => boolean,
  minN = 0,
): Breakdown {
  const groups = new Map<string, Judged[]>();
  for (const j of rows) {
    const key = keyOf(j);
    const g = groups.get(key);
    if (g) g.push(j);
    else groups.set(key, [j]);
  }
  const merged = new Map<string, Judged[]>();
  for (const [key, g] of groups) {
    const target = g.length < minN ? 'other' : key;
    merged.set(target, [...(merged.get(target) ?? []), ...g]);
  }
  return [...merged]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, g]) => ({ key, rate: rate(g.filter(isK).length, g.length) }));
}

export function falseHides(items: readonly EvalItem[], gt: GroundTruth, cohort: Cohort) {
  const hidden = judged(items, gt, cohort).filter((j) => j.item.outcome === 'hidden');
  const isFalse = (j: Judged) => j.item.restored || j.verdict === 'should_stay';
  const restored = hidden.filter((j) => j.item.restored);
  return {
    rate: rate(hidden.filter(isFalse).length, hidden.length),
    restored: restored.length,
    restoredLabelledShouldHide: restored.filter((j) => j.verdict === 'should_hide').length,
    removalsByDelete: hidden.filter((j) => j.item.removalKind === 'delete').length,
    byDecider: breakdown(hidden, (j) => j.item.decider ?? 'unknown', isFalse),
    byCategory: breakdown(hidden, (j) => j.category, isFalse),
    byLanguage: breakdown(hidden, (j) => j.item.language, isFalse, LANGUAGE_MIN_N),
  };
}

export function missed(items: readonly EvalItem[], gt: GroundTruth, cohort: Cohort) {
  const wanted = judged(items, gt, cohort).filter((j) => j.verdict === 'should_hide');
  const isMissed = (j: Judged) => j.item.outcome !== 'hidden';
  return {
    rate: rate(wanted.filter(isMissed).length, wanted.length),
    hideFailed: wanted.filter((j) => j.item.outcome === 'hide_failed').length,
    byCategory: breakdown(wanted, (j) => j.category, isMissed),
    byLanguage: breakdown(wanted, (j) => j.item.language, isMissed, LANGUAGE_MIN_N),
  };
}
