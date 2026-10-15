import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, resolvePolicy, ZERO_SCORES } from './defaults.js';
import { CATEGORIES } from './types.js';

describe('defaults', () => {
  it('flag at 0.8 for every category; hate speech and scam/phishing hide', () => {
    for (const c of CATEGORIES) {
      expect(DEFAULT_THRESHOLDS[c].threshold).toBe(0.8);
      expect(DEFAULT_THRESHOLDS[c].action).toBe(
        c === 'hate_speech' || c === 'scam_phishing' ? 'hide' : 'flag',
      );
      expect(DEFAULT_THRESHOLDS[c].source).toBe('default');
    }
    expect(Object.keys(ZERO_SCORES)).toEqual([...CATEGORIES]);
  });
  it('a brand with no rows gets the defaults (never "no moderation")', () => {
    expect(resolvePolicy([])).toEqual(DEFAULT_THRESHOLDS);
  });
  it('brand rows override per category only', () => {
    const p = resolvePolicy([{ category: 'spam', threshold: 0.6, action: 'hide' }]);
    expect(p.spam).toEqual({ category: 'spam', threshold: 0.6, action: 'hide', source: 'brand' });
    expect(p.profanity).toEqual(DEFAULT_THRESHOLDS.profanity);
  });
  it('ignores unknown categories', () => {
    expect(resolvePolicy([{ category: 'sentiment', threshold: 0.1, action: 'remove' }])).toEqual(
      DEFAULT_THRESHOLDS,
    );
  });
});
