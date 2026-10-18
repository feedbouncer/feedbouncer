import type { GroundTruth } from '../ground-truth.js';
import type { EvalItem, MetaRow } from '../schema.js';
import { rate } from '../stats.js';

export function metaComparison(
  items: readonly EvalItem[],
  gt: GroundTruth,
  meta: readonly MetaRow[] | null,
) {
  if (!meta) return null;
  const byId = new Map(items.map((i) => [i.item, i]));
  let compared = 0;
  let notCompared = 0;
  let reviewExcluded = 0;
  const hide = { both: 0, feedbouncerOnly: 0, metaOnly: 0, neither: 0, n: 0 };
  const stay = { feedbouncerFalseHides: 0, metaFalseHides: 0, n: 0 };
  for (const row of meta) {
    const item = byId.get(row.item);
    if (!item) continue;
    if (item.cohort === 'review') reviewExcluded++;
    else if (row.meta_outcome === 'not_compared') notCompared++;
    else {
      const verdict = gt.verdicts.get(item.item)?.verdict;
      if (!verdict || !item.judgedVersionAvailable) continue;
      compared++;
      const fb = item.caughtByDecision;
      const m = row.meta_outcome === 'hidden';
      if (verdict === 'should_hide') {
        hide.n++;
        if (fb && m) hide.both++;
        else if (fb) hide.feedbouncerOnly++;
        else if (m) hide.metaOnly++;
        else hide.neither++;
      } else {
        stay.n++;
        if (fb) stay.feedbouncerFalseHides++;
        if (m) stay.metaFalseHides++;
      }
    }
  }
  return {
    compared,
    notCompared,
    reviewExcluded,
    shouldHide: hide,
    shouldStay: stay,
    missedShare: {
      feedbouncer: rate(hide.metaOnly + hide.neither, hide.n),
      meta: rate(hide.feedbouncerOnly + hide.neither, hide.n),
    },
  };
}
