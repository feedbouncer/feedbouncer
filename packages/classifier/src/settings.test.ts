import { describe, expect, it } from 'vitest';
import { previewRequestSchema, rerunRequestSchema, thresholdUpdateSchema } from './settings.js';

const upd = (categories: unknown) => thresholdUpdateSchema.safeParse({ categories });

describe('thresholdUpdateSchema', () => {
  it('accepts boundary values 0 and 1 and up to 4 decimals', () => {
    expect(upd([{ category: 'spam', threshold: 0, action: 'flag' }]).success).toBe(true);
    expect(upd([{ category: 'spam', threshold: 1, action: 'remove' }]).success).toBe(true);
    expect(upd([{ category: 'spam', threshold: 0.1234, action: 'hide' }]).success).toBe(true);
  });
  it.each([-0.0001, 1.0001, 2, -1, 0.12345, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects threshold %s',
    (t) => {
      expect(upd([{ category: 'spam', threshold: t, action: 'flag' }]).success).toBe(false);
    },
  );
  it('rejects strings, unknown categories, unknown actions, extra keys and duplicates', () => {
    expect(upd([{ category: 'spam', threshold: '0.8', action: 'flag' }]).success).toBe(false);
    expect(upd([{ category: 'sentiment', threshold: 0.8, action: 'flag' }]).success).toBe(false);
    expect(upd([{ category: 'spam', threshold: 0.8, action: 'delete' }]).success).toBe(false);
    expect(upd([{ category: 'spam', threshold: 0.8, action: 'flag', x: 1 }]).success).toBe(false);
    expect(
      upd([
        { category: 'spam', threshold: 0.8, action: 'flag' },
        { category: 'spam', useDefault: true },
      ]).success,
    ).toBe(false);
    expect(upd([]).success).toBe(false);
  });
  it('accepts a reset-to-default item', () => {
    expect(upd([{ category: 'profanity', useDefault: true }]).success).toBe(true);
  });
  it('error messages name the category and the range', () => {
    const r = upd([{ category: 'hate_speech', threshold: 1.5, action: 'hide' }]);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/between 0 and 1/);
  });
});

describe('preview / rerun requests', () => {
  it('days 1..30, default 7', () => {
    expect(
      previewRequestSchema.parse({
        categories: [{ category: 'spam', threshold: 0.5, action: 'flag' }],
      }).days,
    ).toBe(7);
    expect(
      previewRequestSchema.safeParse({
        categories: [{ category: 'spam', useDefault: true }],
        days: 31,
      }).success,
    ).toBe(false);
    expect(rerunRequestSchema.parse({}).days).toBe(7);
    expect(rerunRequestSchema.safeParse({ days: 0 }).success).toBe(false);
  });
});
