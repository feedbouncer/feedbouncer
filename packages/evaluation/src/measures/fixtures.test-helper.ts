import type { GroundTruth } from '../ground-truth.js';
import type { EvalItem } from '../schema.js';
import { distribution, rate } from '../stats.js';

let seq = 0;

export function item(over: Partial<EvalItem> = {}): EvalItem {
  seq += 1;
  return {
    item: `i_${seq.toString(16).padStart(16, '0')}`,
    cohort: 'automatic',
    channel: 'webhook',
    platform: 'facebook',
    language: 'en',
    judgedVersionAvailable: true,
    ruleDecided: false,
    outcome: 'hidden',
    removalKind: 'hide',
    removalNoop: false,
    restored: false,
    selfReversed: false,
    decider: 'classifier:scam',
    caughtByDecision: true,
    review: null,
    timing: null,
    modelCalls: [],
    ...over,
  };
}

export function truth(
  entries: readonly [EvalItem, 'should_hide' | 'should_stay', string?][],
): GroundTruth {
  return {
    verdicts: new Map(
      entries.map(([i, verdict, category]) => [
        i.item,
        { verdict, category: category ?? 'unspecified' },
      ]),
    ),
    unresolved: 0,
    labelledItems: entries.length,
    labelsPerItem: distribution([]),
    labellerCount: 2,
    agreement: { percent: rate(0, 0), kappa: null, rule: '' },
  };
}
