import { describe, expect, it } from 'vitest';
import type { LabelRow } from './schema.js';
import { InputError } from './io.js';
import { SETTLING_RULE_TEXT, resolveGroundTruth } from './ground-truth.js';

const A = 'i_000000000000000a';
const B = 'i_000000000000000b';
const known = new Set([A, B]);
type V = 'should_hide' | 'should_stay';
const L = (
  item: string,
  labeller: string,
  verdict: V,
  extra: Partial<LabelRow> = {},
): LabelRow => ({ item, labeller, verdict, ...extra });

describe('resolveGroundTruth', () => {
  it('exposes the settling rule text', () => {
    expect(SETTLING_RULE_TEXT).toBe(
      'Each comment is labelled by at least two people independently. The majority verdict wins; a tie is settled by one adjudicator label. A tie with no adjudicator is excluded as unresolved.',
    );
  });

  it('majority of three wins', () => {
    const gt = resolveGroundTruth(
      [L(A, 'a', 'should_hide'), L(A, 'b', 'should_hide'), L(A, 'c', 'should_stay')],
      known,
    );
    expect(gt.verdicts.get(A)?.verdict).toBe('should_hide');
    expect(gt.unresolved).toBe(0);
    expect(gt.labelledItems).toBe(1);
    expect(gt.labellerCount).toBe(3);
  });

  it('tie settled by adjudicator', () => {
    const gt = resolveGroundTruth(
      [
        L(A, 'a', 'should_hide'),
        L(A, 'b', 'should_stay'),
        L(A, 'adj', 'should_stay', { role: 'adjudicator' }),
      ],
      known,
    );
    expect(gt.verdicts.get(A)?.verdict).toBe('should_stay');
    expect(gt.unresolved).toBe(0);
  });

  it('tie without adjudicator counts as unresolved and is absent from verdicts', () => {
    const gt = resolveGroundTruth([L(A, 'a', 'should_hide'), L(A, 'b', 'should_stay')], known);
    expect(gt.verdicts.has(A)).toBe(false);
    expect(gt.unresolved).toBe(1);
    expect(gt.labelledItems).toBe(1);
  });

  it('single label fails', () => {
    expect(() => resolveGroundTruth([L(A, 'a', 'should_hide')], known)).toThrow(InputError);
    try {
      resolveGroundTruth([L(A, 'a', 'should_hide')], known);
    } catch (e) {
      expect((e as InputError).message).toContain(A);
      expect((e as InputError).message).toContain('labels');
    }
  });

  it('an adjudicator does not count towards the two labeller minimum', () => {
    expect(() =>
      resolveGroundTruth(
        [L(A, 'a', 'should_hide'), L(A, 'adj', 'should_hide', { role: 'adjudicator' })],
        known,
      ),
    ).toThrow(InputError);
  });

  it('fails on duplicate labeller, second adjudicator, and unknown item', () => {
    expect(() =>
      resolveGroundTruth(
        [L(A, 'a', 'should_hide'), L(A, 'a', 'should_stay'), L(A, 'b', 'should_stay')],
        known,
      ),
    ).toThrow(InputError);
    expect(() =>
      resolveGroundTruth(
        [
          L(A, 'a', 'should_hide'),
          L(A, 'b', 'should_stay'),
          L(A, 'x', 'should_hide', { role: 'adjudicator' }),
          L(A, 'y', 'should_hide', { role: 'adjudicator' }),
        ],
        known,
      ),
    ).toThrow(InputError);
    expect(() =>
      resolveGroundTruth(
        [L('i_ffffffffffffffff', 'a', 'should_hide'), L('i_ffffffffffffffff', 'b', 'should_hide')],
        known,
      ),
    ).toThrow(InputError);
  });

  it('percent agreement and kappa use first two labels by labeller id', () => {
    const labels = [
      // A: ann/bob agree (hide); zed disagrees but is third by id, so ignored
      L(A, 'zed', 'should_stay'),
      L(A, 'bob', 'should_hide'),
      L(A, 'ann', 'should_hide'),
      // B: ann/bob disagree
      L(B, 'bob', 'should_stay'),
      L(B, 'ann', 'should_hide'),
    ];
    const gt = resolveGroundTruth(labels, known);
    expect(gt.agreement.rule).toBe(SETTLING_RULE_TEXT);
    expect(gt.agreement.percent).toMatchObject({ k: 1, n: 2, value: 0.5 });
    // po=0.5, a: [T,T] b: [T,F] -> pe=1*0.5+0*0.5=0.5 -> kappa 0
    expect(gt.agreement.kappa).toBe(0);
    expect(gt.labelsPerItem).toMatchObject({ n: 2, max: 3 });
  });

  it('category majority, tie → unspecified', () => {
    const gt = resolveGroundTruth(
      [
        L(A, 'a', 'should_hide', { category: 'scam' }),
        L(A, 'b', 'should_hide', { category: 'scam' }),
        L(A, 'c', 'should_hide', { category: 'hate' }),
        L(B, 'a', 'should_hide', { category: 'scam' }),
        L(B, 'b', 'should_hide', { category: 'hate' }),
      ],
      known,
    );
    expect(gt.verdicts.get(A)?.category).toBe('scam');
    expect(gt.verdicts.get(B)?.category).toBe('unspecified');
  });

  it('handles no labels', () => {
    const gt = resolveGroundTruth([], known);
    expect(gt.labelledItems).toBe(0);
    expect(gt.agreement.kappa).toBeNull();
    expect(gt.agreement.percent.status).toBe('not_enough_data');
  });
});
