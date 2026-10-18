import { describe, expect, it } from 'vitest';
import { cohenKappa, confidenceOf, distribution, rate, wilson } from './stats.js';

describe('confidenceOf', () => {
  it('classifies by sample size', () => {
    expect(confidenceOf(0)).toBe('not_enough_data');
    expect(confidenceOf(1)).toBe('low_confidence');
    expect(confidenceOf(29)).toBe('low_confidence');
    expect(confidenceOf(30)).toBe('ok');
  });
});

describe('wilson', () => {
  it('throws on n <= 0', () => {
    expect(() => wilson(0, 0)).toThrow(RangeError);
  });
});

describe('rate', () => {
  it('reports not_enough_data for n=0, never 0', () => {
    expect(rate(0, 0)).toEqual({ status: 'not_enough_data', n: 0 });
  });
  it('computes a low-confidence Wilson interval', () => {
    const r = rate(3, 10);
    if (r.status === 'not_enough_data') throw new Error('unexpected');
    expect(r.status).toBe('low_confidence');
    expect(r.value).toBe(0.3);
    expect(r.ci95[0]).toBeCloseTo(0.1078, 4);
    expect(r.ci95[1]).toBeCloseTo(0.6032, 4);
  });
  it('clamps a zero rate at the lower bound', () => {
    const r = rate(0, 30);
    if (r.status === 'not_enough_data') throw new Error('unexpected');
    expect(r.status).toBe('ok');
    expect(r.value).toBe(0);
    expect(r.ci95[0]).toBe(0);
    expect(r.ci95[1]).toBeCloseTo(0.1135, 4);
  });
});

describe('distribution', () => {
  it('uses nearest rank', () => {
    expect(distribution([5, 1, 4, 2, 3])).toMatchObject({ p50: 3, p95: 5, max: 5, n: 5 });
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(distribution(hundred)).toMatchObject({ status: 'ok', p50: 50, p95: 95, max: 100 });
  });
  it('reports not_enough_data when empty', () => {
    expect(distribution([])).toEqual({ status: 'not_enough_data', n: 0 });
  });
});

describe('cohenKappa', () => {
  it('is 0.6 for 8/10 agreement with 50/50 marginals', () => {
    const pairs: [boolean, boolean][] = [
      ...Array.from({ length: 4 }, () => [true, true] as [boolean, boolean]),
      ...Array.from({ length: 4 }, () => [false, false] as [boolean, boolean]),
      [true, false],
      [false, true],
    ];
    expect(cohenKappa(pairs)).toBeCloseTo(0.6, 10);
  });
  it('is null when expected agreement is 1 or there are no pairs', () => {
    expect(
      cohenKappa([
        [true, true],
        [true, true],
      ]),
    ).toBeNull();
    expect(cohenKappa([])).toBeNull();
  });
});
