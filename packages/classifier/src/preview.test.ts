import { describe, expect, it } from 'vitest';
import { resolvePolicy, ZERO_SCORES } from './defaults.js';
import { previewChange } from './preview.js';

const row = (id: string, s: Partial<Record<string, number>>, extra = {}) => ({
  commentId: id,
  scores: { ...ZERO_SCORES, ...s },
  lowSignal: false,
  languageSupported: true,
  ...extra,
});

describe('previewChange', () => {
  it('counts examined, changed and transitions; never mutates input', () => {
    const rows = [row('a', { spam: 0.7 }), row('b', { spam: 0.9 }), row('c', {})];
    const frozen = JSON.stringify(rows);
    const r = previewChange(
      rows,
      resolvePolicy([]),
      resolvePolicy([{ category: 'spam', threshold: 0.6, action: 'hide' }]),
    );
    expect(r).toMatchObject({
      examined: 3,
      changed: 2,
      transitions: { 'none→hide': 1, 'flag→hide': 1 },
    });
    expect(r.samples).toEqual([
      { commentId: 'a', before: null, after: 'hide' },
      { commentId: 'b', before: 'flag', after: 'hide' },
    ]);
    expect(JSON.stringify(rows)).toBe(frozen);
  });
  it('respects downgrade signals and caps samples at 20', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row(`r${i}`, { hate_speech: 0.9 }, { lowSignal: true }),
    );
    const r = previewChange(
      rows,
      resolvePolicy([{ category: 'hate_speech', threshold: 0.95, action: 'hide' }]),
      resolvePolicy([]),
    );
    expect(r.transitions).toEqual({ 'none→flag': 30 });
    expect(r.samples).toHaveLength(20);
  });
});
