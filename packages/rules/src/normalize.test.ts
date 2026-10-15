import { describe, expect, it } from 'vitest';
import {
  hasUnspacedScript,
  linkText,
  normalizeText,
  stripInvisible,
  truncateForEvaluation,
  words,
} from './normalize.js';

describe('normalizeText', () => {
  it('folds case and Latin accents', () => {
    expect(normalizeText('CAFÉ Crème')).toBe('cafe creme');
  });
  it('folds Greek and Cyrillic accents but keeps Devanagari vowel signs', () => {
    expect(normalizeText('Ἀθῆναι')).toBe('αθηναι');
    expect(normalizeText('हिन\u094Dदी')).toBe('हिन\u094Dदी');
  });
  it('removes zero-width and bidi control characters', () => {
    expect(normalizeText('fr\u200Bee mo\u200Dney\u2060 \uFEFFnow\u00AD')).toBe('free money now');
    expect(normalizeText('a\u202Eb')).toBe('ab');
  });
  it('folds full-width compatibility characters', () => {
    expect(normalizeText('ＦＲＥＥ')).toBe('free');
  });
  it('handles Turkish dotted capital I without leaving a combining dot', () => {
    expect(normalizeText('İstanbul')).toBe('istanbul');
  });
  it('is idempotent', () => {
    const once = normalizeText('Ça Va? ＦＲＥＥ\u200B');
    expect(normalizeText(once)).toBe(once);
  });
  it('returns empty for empty input', () => {
    expect(normalizeText('')).toBe('');
  });
});

describe('words', () => {
  it('splits Latin text on word boundaries, dropping punctuation', () => {
    expect(words('free, money!! now')).toEqual(['free', 'money', 'now']);
  });
  it('segments Japanese and Thai without spaces', () => {
    expect(words('無料でお金').length).toBeGreaterThan(1);
    expect(words('ฟร\u0E35เง\u0E34น').length).toBeGreaterThan(1);
  });
});

describe('hasUnspacedScript', () => {
  it('detects Han, Kana, Thai, Lao, Khmer, Myanmar', () => {
    for (const s of ['無料', 'かな', 'カナ', 'ฟร\u0E35', 'ຟຣ\u0EB5', 'ឥតគ\u17B7តថ\u17D2លៃ', 'အခမ\u1032\u1037'])
      expect(hasUnspacedScript(s)).toBe(true);
    for (const s of ['free', 'бесплатно', '무료', 'مجاني'])
      expect(hasUnspacedScript(s)).toBe(false);
  });
});

describe('stripInvisible / linkText / truncate', () => {
  it('stripInvisible keeps ZWJ out of text but linkText maps ideographic dots', () => {
    expect(stripInvisible('a\u200Db')).toBe('ab');
    expect(linkText('evil。com and bad．io')).toBe('evil.com and bad.io');
  });
  it('linkText keeps accents (IDN hosts) and case for URL parsing', () => {
    expect(linkText('Español.com')).toBe('Español.com');
  });
  it('truncates to 20000 code units without splitting a surrogate pair', () => {
    const s = 'a'.repeat(19_999) + '😀' + 'b';
    const t = truncateForEvaluation(s);
    expect(t.length).toBe(19_999);
    expect(truncateForEvaluation('short')).toBe('short');
  });
});
