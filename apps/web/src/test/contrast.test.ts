import { describe, expect, it } from 'vitest';
import { contrastRatio, flatten, mix } from './contrast';

function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function expectHexNear(actual: string, expected: string): void {
  const a = channels(actual);
  channels(expected).forEach((c, i) => expect(Math.abs(a[i]! - c)).toBeLessThanOrEqual(1));
}

describe('contrast helpers', () => {
  it('rates black on white as 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
  });

  it('documents why the website accent-text fails on coral', () => {
    expect(contrastRatio('#fdf1ee', '#e06952')).toBeLessThan(4.5);
  });

  it('composites an 8-digit colour over its backdrop', () => {
    expectHexNear(flatten('#e0695233', '#161b29'), '#3e2b31');
  });

  it('returns a 6-digit colour unchanged', () => {
    expect(flatten('#e06952', '#161b29')).toBe('#e06952');
  });

  it('mixes in sRGB like color-mix', () => {
    expectHexNear(mix('#ff0000', '#000000', 0.5), '#800000');
  });
});
