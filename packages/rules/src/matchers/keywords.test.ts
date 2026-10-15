import { describe, expect, it } from 'vitest';
import { CommentView } from '../view.js';
import { compileKeywordRule, compileKeywords } from './keywords.js';

const v = (body: string) =>
  new CommentView({ body, platform: 'facebook', authorExternalId: null, authorName: null });

describe('keywords whole_word (default)', () => {
  const m = compileKeywords(['Free money', 'scam', 'café', '無料', '$$$'], 'whole_word');
  it('is case/accent-insensitive and matches phrases across punctuation and spaces', () => {
    expect(m.find(v('FREE,   Money here'))).toBe('Free money');
    expect(m.find(v('Cafe time'))).toBe('café');
  });
  it('does not match inside other words', () => {
    expect(m.find(v('scampi for dinner'))).toBeNull();
  });
  it('ignores zero-width obfuscation', () => {
    expect(m.find(v('s​cam'))).toBe('scam');
  });
  it('uses substring matching for unspaced scripts', () => {
    expect(m.find(v('今日は無料です'))).toBe('無料');
  });
  it('falls back to substring for punctuation-only terms', () => {
    expect(m.find(v('win $$$ now'))).toBe('$$$');
  });
  it('never matches with an empty list, and not on empty or emoji-only comments', () => {
    expect(compileKeywords([], 'whole_word').find(v('anything'))).toBeNull();
    expect(m.find(v(''))).toBeNull();
    expect(m.find(v('🔥🔥'))).toBeNull();
  });
  it('terms that normalise to nothing can never match', () => {
    for (const mode of ['whole_word', 'contains'] as const) {
      const e = compileKeywords(['', '​‍', ' ', ' '], mode);
      expect(e.find(v('anything at all'))).toBeNull();
      expect(e.covers('anything')).toBe(false);
      expect(e.covers('')).toBe(false);
    }
  });
  it('covers() reports whether a comment of exactly that text would match', () => {
    expect(m.covers('SCAM')).toBe(true);
    expect(m.covers('hello')).toBe(false);
  });
});

describe('keywords contains', () => {
  it('matches inside words', () => {
    expect(compileKeywords(['scam'], 'contains').find(v('scampi'))).toBe('scam');
  });
  it('rule wrapper returns keyword evidence', () => {
    const r = compileKeywordRule({ type: 'keyword', terms: ['scam'], match: 'contains' });
    expect(r(v('scampi'), { now: () => 0, startedAt: 0, limitMs: 50 })).toEqual({
      kind: 'keyword',
      term: 'scam',
    });
  });
});
