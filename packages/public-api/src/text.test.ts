import { describe, expect, it } from 'vitest';
import { publicStatus, truncateText } from './text.js';

describe('truncateText', () => {
  it('cuts astral text at exactly 10,000 code points without a lone surrogate', () => {
    const out = truncateText('😀'.repeat(10_001));
    expect(out.truncated).toBe(true);
    expect([...out.text]).toHaveLength(10_000);
    expect(/\p{Cs}/u.test(out.text)).toBe(false);
  });

  it('keeps text at the limit', () => {
    const out = truncateText('a'.repeat(10_000));
    expect(out).toEqual({ text: 'a'.repeat(10_000), truncated: false });
  });
});

describe('publicStatus', () => {
  it('ranks hidden over flagged over visible', () => {
    expect(publicStatus('hidden', true)).toBe('hidden');
    expect(publicStatus('visible', true)).toBe('flagged');
    expect(publicStatus('visible', false)).toBe('visible');
  });
});
