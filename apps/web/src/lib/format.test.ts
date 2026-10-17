import { describe, expect, it } from 'vitest';
import { formatExactUtc, formatUtc } from './format';

describe('formatExactUtc', () => {
  it('includes seconds', () => {
    expect(formatExactUtc('2026-10-27T10:04:05.678Z')).toBe('2026-10-27 10:04:05 UTC');
  });

  it('is empty for an invalid date', () => {
    expect(formatExactUtc('nope')).toBe('');
    expect(formatUtc('nope')).toBe('');
  });
});
