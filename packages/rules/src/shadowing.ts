import type { ActionStep } from '@feedbouncer/actions';
import {
  checkActionForConditions,
  ruleConditionsSchema,
  type AuthorConditions,
  type EmojiConditions,
  type KeywordConditions,
  type LinkDomainConditions,
  type RuleConditions,
} from './conditions.js';
import { isUnder } from './domains.js';
import { emojiKey } from './emoji.js';
import { ruleOrder } from './engine.js';
import { compileKeywords, type KeywordMatcher } from './matchers/keywords.js';
import { hasUnspacedScript, normalizeText, words } from './normalize.js';
import { scopeCovers, type RuleAppliesTo, type RuleMode } from './types.js';

export interface AnalyzableRule {
  id: string;
  conditions: unknown;
  actions: ActionStep[];
  mode: RuleMode;
  enabled: boolean;
  priority: number;
  appliesTo: RuleAppliesTo;
  createdAt: Date;
}

export interface RuleWarnings {
  shadowedBy: string | null;
  neverMatches: boolean;
  invalid: boolean;
}

// Keyword-like view of a keyword or competitor rule. Competitor names are whole-word.
interface TermSet {
  terms: readonly string[];
  mode: 'whole_word' | 'contains';
}
function termSet(c: RuleConditions): TermSet | null {
  if (c.type === 'keyword') return { terms: (c as KeywordConditions).terms, mode: c.match };
  // A competitor with handles or domains matches more than its names, so it is only
  // treated as a term list when it has names alone.
  if (c.type === 'competitor' && c.handles.length === 0 && c.domains.length === 0)
    return { terms: c.names, mode: 'whole_word' };
  return null;
}
// For A the extra handles/domains only widen what it matches, so names alone are a safe subset.
function termSetForA(c: RuleConditions): TermSet | null {
  if (c.type === 'competitor') return { terms: c.names, mode: 'whole_word' };
  return termSet(c);
}

const normHandle = (h: string) => normalizeText(h.replace(/^@/, '')).trim();

function isSubstringMatched(term: string, mode: 'whole_word' | 'contains'): boolean {
  if (mode === 'contains') return true;
  const n = normalizeText(term).trim();
  return hasUnspacedScript(n) || words(n).length === 0;
}

interface Prepared {
  rule: AnalyzableRule;
  conditions: RuleConditions | null;
  pinned: boolean;
  keywords: KeywordMatcher | null;
  neverMatches: boolean;
}

function neverMatchesFor(c: RuleConditions): boolean {
  switch (c.type) {
    case 'keyword':
      return c.terms.length === 0;
    case 'regex':
      return c.patterns.length === 0;
    case 'link_domain':
      return (
        c.mode === 'blocklist' &&
        c.domains.length === 0 &&
        c.shorteners === 'ignore' &&
        c.lookalikes === 'ignore'
      );
    default:
      return false;
  }
}

function coversKeywords(A: Prepared, B: Prepared): boolean {
  const a = A.conditions && termSetForA(A.conditions);
  const b = B.conditions && termSet(B.conditions);
  if (!a || !b || !A.keywords || b.terms.length === 0) return false;
  return b.terms.every(
    (t) =>
      A.keywords!.covers(t) && (!isSubstringMatched(t, b.mode) || A.keywords!.mode === 'contains'),
  );
}

const subset = <T>(xs: Iterable<T>, of: Set<T>) => [...xs].every((x) => of.has(x));
const underSome = (host: string, domains: readonly string[]) =>
  domains.some((d) => isUnder(host, d));

function coversLinks(a: LinkDomainConditions, b: LinkDomainConditions): boolean {
  if (a.mode !== b.mode) return false;
  const domainsOk =
    a.mode === 'blocklist'
      ? b.domains.every((d) => underSome(d, a.domains))
      : a.domains.every((d) => underSome(d, b.domains));
  return (
    domainsOk &&
    (b.shorteners !== 'match' || a.shorteners === 'match') &&
    (b.lookalikes !== 'match' || a.lookalikes === 'match') &&
    (!a.exemptOwnDomains || b.exemptOwnDomains)
  );
}

function coversEmoji(a: EmojiConditions, b: EmojiConditions): boolean {
  const keys = new Set(a.emoji.map(emojiKey));
  if (!b.emoji.every((e) => keys.has(emojiKey(e)))) return false;
  return b.maxCount === null || (a.maxCount !== null && a.maxCount <= b.maxCount);
}

function authorSets(c: AuthorConditions) {
  const ids = new Set<string>();
  const handles = new Set<string>();
  for (const e of c.entries) {
    if (e.externalId !== undefined && e.externalId.length > 0) ids.add(e.externalId);
    else if (e.handle !== undefined) {
      const h = normHandle(e.handle);
      if (h.length > 0) handles.add(h);
    }
  }
  return { ids, handles };
}

function coversAuthors(a: AuthorConditions, b: AuthorConditions): boolean {
  if (a.platform !== b.platform) return false;
  const sa = authorSets(a);
  const sb = authorSets(b);
  // Handles only match on block lists; elsewhere they are inert, so A has none to offer.
  const aHandles = a.list === 'block' ? sa.handles : new Set<string>();
  // B's inert handles (non-block list) cannot match anything, so they need no cover.
  const bHandles = b.list === 'block' ? sb.handles : new Set<string>();
  return subset(sb.ids, sa.ids) && subset(bHandles, aHandles);
}

function covers(A: Prepared, B: Prepared): boolean {
  const a = A.conditions;
  const b = B.conditions;
  if (!a || !b) return false;
  switch (`${a.type}>${b.type}`) {
    case 'keyword>keyword':
    case 'keyword>competitor':
    case 'competitor>keyword':
    case 'competitor>competitor':
      return coversKeywords(A, B);
    case 'regex>regex': {
      if (a.type !== 'regex' || b.type !== 'regex' || b.patterns.length === 0) return false;
      return subset(b.patterns, new Set(a.patterns));
    }
    case 'link_domain>link_domain':
      return (
        a.type === 'link_domain' && b.type === 'link_domain' && !B.neverMatches && coversLinks(a, b)
      );
    case 'emoji>emoji':
      return a.type === 'emoji' && b.type === 'emoji' && coversEmoji(a, b);
    case 'author>author':
      return a.type === 'author' && b.type === 'author' && coversAuthors(a, b);
    default:
      return false;
  }
}

/**
 * Static analysis of a brand's rules. Conservative: a shadow may be missed but is never
 * reported falsely. Dry-run, disabled and invalid rules never shadow anything.
 */
export function analyzeRules(rules: readonly AnalyzableRule[]): Map<string, RuleWarnings> {
  const prepared: Prepared[] = rules.map((rule) => {
    const parsed = ruleConditionsSchema.safeParse(rule.conditions);
    const ok = parsed.success && checkActionForConditions(parsed.data, rule.actions) === null;
    const conditions = ok ? parsed.data : null;
    const ts = conditions && termSetForA(conditions);
    return {
      rule,
      conditions,
      pinned: conditions?.type === 'author' && conditions.list === 'trusted',
      keywords: ts ? compileKeywords(ts.terms, ts.mode) : null,
      neverMatches: conditions ? neverMatchesFor(conditions) : false,
    };
  });
  const ordered = [...prepared].sort((x, y) =>
    ruleOrder({ ...x.rule, pinned: x.pinned }, { ...y.rule, pinned: y.pinned }),
  );
  const out = new Map<string, RuleWarnings>();
  ordered.forEach((B, i) => {
    let shadowedBy: string | null = null;
    if (B.conditions && !B.neverMatches) {
      for (let j = 0; j < i; j++) {
        const A = ordered[j]!;
        if (!A.conditions || !A.rule.enabled || A.rule.mode !== 'enforce') continue;
        if (!scopeCovers(A.rule.appliesTo, B.rule.appliesTo)) continue;
        if (covers(A, B)) {
          shadowedBy = A.rule.id;
          break;
        }
      }
    }
    out.set(B.rule.id, {
      shadowedBy,
      neverMatches: B.neverMatches,
      invalid: B.conditions === null,
    });
  });
  return out;
}
