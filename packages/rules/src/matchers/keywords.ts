import type { KeywordConditions } from '../conditions.js';
import { hasUnspacedScript, normalizeText, words } from '../normalize.js';
import type { CommentView } from '../view.js';
import type { Matcher } from './types.js';

export interface KeywordMatcher {
  mode: 'whole_word' | 'contains';
  find(v: CommentView): string | null;
  /** True if a comment consisting of exactly `text` would match (used by shadowing analysis). */
  covers(text: string): boolean;
}

interface Phrase {
  tokens: string[];
  term: string;
}

export function compileKeywords(
  terms: readonly string[],
  mode: 'whole_word' | 'contains',
): KeywordMatcher {
  const substrings: { needle: string; term: string }[] = [];
  const byFirst = new Map<string, Phrase[]>();
  for (const term of terms) {
    // A term with nothing left after normalisation must never match (an empty
    // needle would match every comment).
    const n = normalizeText(term).trim();
    if (n.length === 0) continue;
    const toks = words(n);
    if (mode === 'contains' || hasUnspacedScript(n) || toks.length === 0) {
      substrings.push({ needle: n, term });
      continue;
    }
    const list = byFirst.get(toks[0]!) ?? [];
    list.push({ tokens: toks, term });
    byFirst.set(toks[0]!, list);
  }
  const findIn = (normalized: string, ws: readonly string[]): string | null => {
    if (normalized.length === 0) return null;
    for (let i = 0; i < ws.length; i++) {
      const cands = byFirst.get(ws[i]!);
      if (!cands) continue;
      for (const p of cands) {
        let ok = i + p.tokens.length <= ws.length;
        for (let k = 1; ok && k < p.tokens.length; k++) ok = ws[i + k] === p.tokens[k];
        if (ok) return p.term;
      }
    }
    for (const s of substrings) if (normalized.includes(s.needle)) return s.term;
    return null;
  };
  return {
    mode,
    find: (v) => findIn(v.normalized, v.words),
    covers: (text) => {
      const n = normalizeText(text);
      return findIn(n, words(n)) !== null;
    },
  };
}

export function compileKeywordRule(c: KeywordConditions): Matcher {
  const m = compileKeywords(c.terms, c.match);
  return (v) => {
    const term = m.find(v);
    return term === null ? null : { kind: 'keyword', term };
  };
}
