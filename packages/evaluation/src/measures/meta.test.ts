import { describe, expect, it } from 'vitest';
import { metaComparison } from './meta.js';
import { item, truth } from './fixtures.test-helper.js';
import type { MetaRow } from '../schema.js';

const row = (i: { item: string }, meta_outcome: MetaRow['meta_outcome']): MetaRow => ({
  item: i.item,
  meta_outcome,
});

describe('metaComparison', () => {
  it('2x2 counts on should_hide and should_stay false hides', () => {
    const both = item();
    const fbOnly = item();
    const metaOnly = item({ caughtByDecision: false });
    const neither = item({ caughtByDecision: false });
    const stay = item();
    const gt = truth([
      [both, 'should_hide'],
      [fbOnly, 'should_hide'],
      [metaOnly, 'should_hide'],
      [neither, 'should_hide'],
      [stay, 'should_stay'],
    ]);
    const r = metaComparison([both, fbOnly, metaOnly, neither, stay], gt, [
      row(both, 'hidden'),
      row(fbOnly, 'visible'),
      row(metaOnly, 'hidden'),
      row(neither, 'visible'),
      row(stay, 'hidden'),
    ])!;
    expect(r.shouldHide).toEqual({ both: 1, feedbouncerOnly: 1, metaOnly: 1, neither: 1, n: 4 });
    expect(r.shouldStay).toEqual({ feedbouncerFalseHides: 1, metaFalseHides: 1, n: 1 });
    expect(r.missedShare.feedbouncer).toMatchObject({ k: 2, n: 4 });
    expect(r.missedShare.meta).toMatchObject({ k: 2, n: 4 });
    expect(r.compared).toBe(5);
  });

  it('not_compared rows and review cohort excluded and counted', () => {
    const a = item();
    const b = item();
    const c = item({ cohort: 'review' });
    const r = metaComparison([a, b, c], truth([[a, 'should_hide']]), [
      row(a, 'hidden'),
      row(b, 'not_compared'),
      row(c, 'hidden'),
    ])!;
    expect(r).toMatchObject({ compared: 1, notCompared: 1, reviewExcluded: 1 });
  });

  it('meta null gives null', () => {
    expect(metaComparison([], truth([]), null)).toBeNull();
  });
});
