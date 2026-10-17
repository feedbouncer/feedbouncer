import { describe, expect, it } from 'vitest';
import {
  adLabel,
  formatChange,
  formatCount,
  formatDuration,
  formatPercent,
  formatRange,
  platformLabel,
  sanitizeName,
} from './format.js';

describe('format', () => {
  it("formatCount(1234567) → '1,234,567'", () => {
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it('formatPercent to one decimal', () => {
    expect(formatPercent(1, 3)).toBe('33.3%');
    expect(formatPercent(2, 3)).toBe('66.7%');
    expect(formatPercent(1, 1)).toBe('100.0%');
  });

  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(29)).toBe('under 1 min');
    expect(formatDuration(30)).toBe('1 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(12000)).toBe('3 h 20 min');
  });

  it('formatChange', () => {
    expect(formatChange(120, 100)).toBe('+20 (+20.0%) vs. the week before');
    expect(formatChange(80, 100)).toBe('-20 (-20.0%) vs. the week before');
    expect(formatChange(5, 0)).toBe('New this week (no comments the week before)');
    expect(formatChange(7, 7)).toBe('Same as the week before');
  });

  it("formatRange Berlin week of 2026-10-19 → 'Oct 19 – Oct 25, 2026 (Europe/Berlin)'", () => {
    expect(
      formatRange('2026-10-18T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 'Europe/Berlin'),
    ).toBe('Oct 19 – Oct 25, 2026 (Europe/Berlin)');
  });

  it('sanitizeName strips bidi/control chars and truncates to 80 code points', () => {
    expect(sanitizeName('a\u202Eb\u0000c\u0085d\u200Fe\u2067f\n\tg  h')).toBe('a b c d e f g h');
    const long = '😀'.repeat(81);
    expect(sanitizeName(long)).toBe(`${'😀'.repeat(80)}…`);
    expect(sanitizeName('😀'.repeat(80))).toBe('😀'.repeat(80));
  });

  it('adLabel appends the external id suffix; platformLabel lists platforms', () => {
    const a = {
      adId: 'x',
      externalId: '120000000123456',
      name: null,
      platforms: ['facebook', 'instagram'] as const,
      brandId: 'b',
      archived: false,
      hidden: 1,
      total: 10,
    };
    expect(adLabel({ ...a, platforms: [...a.platforms] })).toBe('Unnamed ad · #123456');
    expect(platformLabel(['facebook', 'instagram'])).toBe('Facebook + Instagram');
    expect(platformLabel(['instagram'])).toBe('Instagram');
  });
});
