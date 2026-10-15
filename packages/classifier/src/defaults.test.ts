import { describe, expect, it } from 'vitest';
import { applyItems, DEFAULT_THRESHOLDS, resolvePolicy, ZERO_SCORES } from './defaults.js';
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
  describe('applyItems', () => {
    const current = resolvePolicy([
      { category: 'spam', threshold: 0.5, action: 'remove' },
      { category: 'profanity', threshold: 0.3, action: 'hide' },
    ]);
    it('useDefault restores the default for that category', () => {
      const p = applyItems(current, [{ category: 'spam', useDefault: true }]);
      expect(p.spam).toEqual(DEFAULT_THRESHOLDS.spam);
    });
    it('an override sets source brand', () => {
      const p = applyItems(DEFAULT_THRESHOLDS, [
        { category: 'spam', threshold: 0.6, action: 'hide' },
      ]);
      expect(p.spam).toEqual({ category: 'spam', threshold: 0.6, action: 'hide', source: 'brand' });
    });
    it('leaves other categories untouched and does not mutate the input', () => {
      const p = applyItems(current, [{ category: 'spam', useDefault: true }]);
      expect(p.profanity).toEqual(current.profanity);
      expect(current.spam.source).toBe('brand');
    });
  });
});
