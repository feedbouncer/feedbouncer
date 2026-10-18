import { describe, expect, it } from 'vitest';
import { falseHides, missed } from './hides.js';
import { item, truth } from './fixtures.js';

describe('falseHides', () => {
  it('restored hide counts as false hide even when labelled should_hide, and not as correct', () => {
    const a = item({ restored: true });
    const b = item();
    const r = falseHides(
      [a, b],
      truth([
        [a, 'should_hide'],
        [b, 'should_hide'],
      ]),
      'automatic',
    );
    expect(r.rate).toMatchObject({ k: 1, n: 2 });
    expect(r.restored).toBe(1);
    expect(r.restoredLabelledShouldHide).toBe(1);
  });

  it('unresolved and judgedVersionAvailable=false items are excluded from n', () => {
    const a = item();
    const b = item({ judgedVersionAvailable: false });
    const c = item();
    const r = falseHides(
      [a, b, c],
      truth([
        [a, 'should_stay'],
        [b, 'should_stay'],
      ]),
      'automatic',
    );
    expect(r.rate).toMatchObject({ k: 1, n: 1 });
  });

  it('review cohort is not pooled with automatic', () => {
    const a = item();
    const b = item({ cohort: 'review' });
    const gt = truth([
      [a, 'should_stay'],
      [b, 'should_stay'],
    ]);
    expect(falseHides([a, b], gt, 'automatic').rate).toMatchObject({ k: 1, n: 1 });
    expect(falseHides([a, b], gt, 'review').rate).toMatchObject({ k: 1, n: 1 });
  });

  it('no hidden items gives not_enough_data', () => {
    const a = item({ outcome: 'not_hidden', removalKind: null, caughtByDecision: false });
    const r = falseHides([a], truth([[a, 'should_stay']]), 'automatic');
    expect(r.rate).toEqual({ status: 'not_enough_data', n: 0 });
  });

  it('languages with n<30 pool into other', () => {
    const many = Array.from({ length: 30 }, () => item({ language: 'en' }));
    const few = [item({ language: 'de' }), item({ language: 'fr' })];
    const gt = truth([...many, ...few].map((i) => [i, 'should_stay'] as const));
    const r = falseHides([...many, ...few], gt, 'automatic');
    expect(r.byLanguage.map((b) => b.key).sort()).toEqual(['en', 'other']);
    expect(r.byLanguage.find((b) => b.key === 'other')!.rate).toMatchObject({ n: 2 });
  });

  it('byCategory exposes complaint and byDecider and delete count are reported', () => {
    const a = item({ removalKind: 'delete', decider: 'rule:link_domain' });
    const b = item();
    const r = falseHides(
      [a, b],
      truth([
        [a, 'should_stay', 'complaint'],
        [b, 'should_hide', 'scam'],
      ]),
      'automatic',
    );
    expect(r.byCategory.find((c) => c.key === 'complaint')!.rate).toMatchObject({ k: 1, n: 1 });
    expect(r.byDecider.find((c) => c.key === 'rule:link_domain')!.rate).toMatchObject({
      k: 1,
      n: 1,
    });
    expect(r.removalsByDelete).toBe(1);
  });
});

describe('missed', () => {
  const notHidden = { removalKind: null, caughtByDecision: false } as const;

  it('hide_failed counts as missed and is reported in hideFailed', () => {
    const a = item({ outcome: 'hide_failed', ...notHidden });
    const b = item();
    const r = missed(
      [a, b],
      truth([
        [a, 'should_hide'],
        [b, 'should_hide'],
      ]),
      'automatic',
    );
    expect(r.rate).toMatchObject({ k: 1, n: 2 });
    expect(r.hideFailed).toBe(1);
  });

  it('manual-hidden should_hide item is missed', () => {
    const a = item({ outcome: 'not_hidden', decider: null, ...notHidden });
    const r = missed([a], truth([[a, 'should_hide', 'spam_bot']]), 'automatic');
    expect(r.rate).toMatchObject({ k: 1, n: 1 });
    expect(r.byCategory[0]).toMatchObject({ key: 'spam_bot' });
  });

  it('no should_hide labels gives not_enough_data', () => {
    const a = item();
    expect(missed([a], truth([[a, 'should_stay']]), 'automatic').rate).toEqual({
      status: 'not_enough_data',
      n: 0,
    });
  });
});
