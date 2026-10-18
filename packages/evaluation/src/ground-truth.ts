import { MIN_LABELS_PER_ITEM } from './constants.js';
import { InputError } from './io.js';
import type { LabelRow } from './schema.js';
import { cohenKappa, distribution, rate, type Distribution, type Rate } from './stats.js';

export const SETTLING_RULE_TEXT =
  'Each comment is labelled by at least two people independently. The majority verdict wins; a tie is settled by one adjudicator label. A tie with no adjudicator is excluded as unresolved.';

type Verdict = 'should_hide' | 'should_stay';

export type GroundTruth = {
  verdicts: ReadonlyMap<string, { verdict: Verdict; category: string }>;
  unresolved: number;
  labelledItems: number;
  labelsPerItem: Distribution;
  labellerCount: number;
  agreement: { percent: Rate; kappa: number | null; rule: string };
};

const fail = (reason: string): never => {
  throw new InputError('labels', 'all rows', 'item', reason);
};

function categoryOf(labels: readonly LabelRow[]): string {
  const counts = new Map<string, number>();
  for (const l of labels) {
    if (l.category) counts.set(l.category, (counts.get(l.category) ?? 0) + 1);
  }
  let best = 0;
  let winners: string[] = [];
  for (const [cat, n] of counts) {
    if (n > best) {
      best = n;
      winners = [cat];
    } else if (n === best) winners.push(cat);
  }
  return winners.length === 1 ? winners[0]! : 'unspecified';
}

export function resolveGroundTruth(
  labels: readonly LabelRow[],
  knownItems: ReadonlySet<string>,
): GroundTruth {
  const byItem = new Map<string, LabelRow[]>();
  for (const l of labels) {
    if (!knownItems.has(l.item)) fail(`unknown item id (first: ${l.item})`);
    const list = byItem.get(l.item);
    if (list) list.push(l);
    else byItem.set(l.item, [l]);
  }

  const verdicts = new Map<string, { verdict: Verdict; category: string }>();
  const labellers = new Set<string>();
  const counts: number[] = [];
  const pairs: [boolean, boolean][] = [];
  let unresolved = 0;
  let tooFew = 0;
  let firstTooFew = '';
  let dupes = 0;
  let firstDupe = '';
  let multiAdj = 0;
  let firstMultiAdj = '';

  for (const [item, list] of byItem) {
    const seen = new Set<string>();
    let dup = false;
    for (const l of list) {
      if (seen.has(l.labeller)) dup = true;
      seen.add(l.labeller);
      labellers.add(l.labeller);
    }
    if (dup) {
      if (dupes++ === 0) firstDupe = item;
      continue;
    }
    const adjudicators = list.filter((l) => l.role === 'adjudicator');
    const regular = list
      .filter((l) => l.role !== 'adjudicator')
      .sort((a, b) => (a.labeller < b.labeller ? -1 : a.labeller > b.labeller ? 1 : 0));
    if (adjudicators.length > 1) {
      if (multiAdj++ === 0) firstMultiAdj = item;
      continue;
    }
    if (regular.length < MIN_LABELS_PER_ITEM) {
      if (tooFew++ === 0) firstTooFew = item;
      continue;
    }
    counts.push(list.length);
    pairs.push([regular[0]!.verdict === 'should_hide', regular[1]!.verdict === 'should_hide']);

    const hide = regular.filter((l) => l.verdict === 'should_hide').length;
    const stay = regular.length - hide;
    let verdict: Verdict | null = null;
    if (hide !== stay) verdict = hide > stay ? 'should_hide' : 'should_stay';
    else if (adjudicators[0]) verdict = adjudicators[0].verdict;
    if (verdict === null) {
      unresolved++;
      continue;
    }
    const agreeing = list.filter((l) => l.verdict === verdict);
    verdicts.set(item, { verdict, category: categoryOf(agreeing) });
  }

  if (dupes > 0) fail(`${dupes} item(s) with a labeller labelling twice (first: ${firstDupe})`);
  if (multiAdj > 0)
    fail(`${multiAdj} item(s) with more than one adjudicator label (first: ${firstMultiAdj})`);
  if (tooFew > 0) {
    fail(
      `${tooFew} item(s) with fewer than ${MIN_LABELS_PER_ITEM} labellers (first: ${firstTooFew})`,
    );
  }

  const agreed = pairs.filter(([a, b]) => a === b).length;
  return {
    verdicts,
    unresolved,
    labelledItems: byItem.size,
    labelsPerItem: distribution(counts),
    labellerCount: labellers.size,
    agreement: {
      percent: rate(agreed, pairs.length),
      kappa: cohenKappa(pairs),
      rule: SETTLING_RULE_TEXT,
    },
  };
}
