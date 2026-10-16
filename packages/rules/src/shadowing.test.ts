import { describe, expect, it } from 'vitest';
import { analyzeRules, type AnalyzableRule } from './shadowing.js';

let n = 0;
const r = (
  conditions: unknown,
  priority: number,
  over: Partial<AnalyzableRule> = {},
): AnalyzableRule => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  conditions,
  actions: [{ type: 'hide' }],
  mode: 'enforce',
  enabled: true,
  priority,
  createdAt: new Date(0),
  ...over,
});
const shadow = (a: AnalyzableRule, b: AnalyzableRule) => analyzeRules([a, b]).get(b.id)!.shadowedBy;
const kw = (terms: string[], match: 'whole_word' | 'contains' = 'whole_word') => ({
  type: 'keyword',
  terms,
  match,
});
const links = (over: object = {}) => ({
  type: 'link_domain',
  mode: 'blocklist',
  domains: ['bad.com'],
  exemptOwnDomains: true,
  shorteners: 'match',
  lookalikes: 'match',
  ...over,
});
const authors = (list: string, entries: object[]) => ({
  type: 'author',
  list,
  platform: 'facebook',
  entries,
});

describe('keyword shadowing', () => {
  it('whole-word keyword A covers B whose terms contain an A term as words', () => {
    const A = r(kw(['crypto']), 10);
    const B = r(kw(['free crypto', 'crypto giveaway']), 20);
    expect(analyzeRules([A, B]).get(B.id)).toEqual({
      shadowedBy: A.id,
      neverMatches: false,
      invalid: false,
    });
  });
  it('is not shadowed when one term is not covered', () => {
    expect(shadow(r(kw(['crypto']), 10), r(kw(['free crypto', 'scam']), 20))).toBeNull();
  });
  it('whole-word A does not shadow contains B', () => {
    expect(shadow(r(kw(['spam']), 10), r(kw(['spam'], 'contains'), 20))).toBeNull();
  });
  it('contains A shadows contains B and whole-word B', () => {
    const A = r(kw(['spam'], 'contains'), 10);
    expect(shadow(A, r(kw(['spammer'], 'contains'), 20))).toBe(A.id);
    expect(shadow(A, r(kw(['spammer']), 20))).toBe(A.id);
  });
  it('unspaced-script terms need a contains A', () => {
    expect(shadow(r(kw(['垃圾']), 10), r(kw(['垃圾邮件']), 20))).toBeNull();
    const A = r(kw(['垃圾'], 'contains'), 10);
    expect(shadow(A, r(kw(['垃圾邮件']), 20))).toBe(A.id);
  });
  it('competitor names are covered by keyword A', () => {
    const A = r(kw(['acme']), 10);
    expect(
      shadow(A, r({ type: 'competitor', names: ['acme corp'], handles: [], domains: [] }, 20)),
    ).toBe(A.id);
  });
  it('competitor B with handles or domains is not covered', () => {
    const A = r(kw(['acme']), 10);
    expect(
      shadow(
        A,
        r({ type: 'competitor', names: ['acme corp'], handles: ['acme'], domains: [] }, 20),
      ),
    ).toBeNull();
  });
  it('competitor A covers keyword B', () => {
    const A = r({ type: 'competitor', names: ['acme'], handles: [], domains: ['acme.com'] }, 10);
    expect(shadow(A, r(kw(['acme rocks']), 20))).toBe(A.id);
  });
  it('B with no terms is never reported as shadowed', () => {
    const A = r(kw(['x']), 10);
    const B = r(kw([]), 20);
    expect(analyzeRules([A, B]).get(B.id)).toEqual({
      shadowedBy: null,
      neverMatches: true,
      invalid: false,
    });
  });
});

describe('regex shadowing', () => {
  it('subset of patterns is shadowed', () => {
    const A = r({ type: 'regex', patterns: ['a+', 'b+'] }, 10);
    expect(shadow(A, r({ type: 'regex', patterns: ['b+'] }, 20))).toBe(A.id);
  });
  it('a pattern outside A is not shadowed', () => {
    expect(
      shadow(
        r({ type: 'regex', patterns: ['a+'] }, 10),
        r({ type: 'regex', patterns: ['a+', 'c'] }, 20),
      ),
    ).toBeNull();
  });
  it('regex A never shadows a keyword B', () => {
    expect(shadow(r({ type: 'regex', patterns: ['^spam$'] }, 10), r(kw(['spam']), 20))).toBeNull();
  });
  it('empty pattern list never matches', () => {
    const B = r({ type: 'regex', patterns: [] }, 20);
    expect(analyzeRules([B]).get(B.id)).toEqual({
      shadowedBy: null,
      neverMatches: true,
      invalid: false,
    });
  });
});

describe('link domain shadowing', () => {
  it('blocklist A covers B with subdomains', () => {
    const A = r(links({ domains: ['bad.com', 'worse.com'] }), 10);
    expect(shadow(A, r(links({ domains: ['x.bad.com'] }), 20))).toBe(A.id);
  });
  it('blocklist with a domain outside A is not shadowed', () => {
    expect(shadow(r(links(), 10), r(links({ domains: ['bad.com', 'other.com'] }), 20))).toBeNull();
  });
  it('flag implications are enforced', () => {
    expect(shadow(r(links({ shorteners: 'ignore' }), 10), r(links(), 20))).toBeNull();
    expect(shadow(r(links({ lookalikes: 'ignore' }), 10), r(links(), 20))).toBeNull();
    const A = r(links({ shorteners: 'ignore' }), 10);
    expect(shadow(A, r(links({ shorteners: 'ignore' }), 20))).toBe(A.id);
  });
  it('A exemptOwnDomains requires B exemptOwnDomains', () => {
    expect(
      shadow(r(links({ exemptOwnDomains: true }), 10), r(links({ exemptOwnDomains: false }), 20)),
    ).toBeNull();
    const A = r(links({ exemptOwnDomains: false }), 10);
    expect(shadow(A, r(links({ exemptOwnDomains: true }), 20))).toBe(A.id);
  });
  it('allowlist A covers B when every A domain is under a B domain', () => {
    const A = r(links({ mode: 'allowlist', domains: ['shop.good.com'] }), 10);
    expect(shadow(A, r(links({ mode: 'allowlist', domains: ['good.com'] }), 20))).toBe(A.id);
    expect(
      shadow(
        r(links({ mode: 'allowlist', domains: ['good.com'] }), 10),
        r(links({ mode: 'allowlist', domains: ['shop.good.com'] }), 20),
      ),
    ).toBeNull();
  });
  it('blocklist and allowlist never cover each other', () => {
    expect(shadow(r(links(), 10), r(links({ mode: 'allowlist' }), 20))).toBeNull();
  });
  it('blocklist with no domains and both flags ignored never matches', () => {
    const B = r(links({ domains: [], shorteners: 'ignore', lookalikes: 'ignore' }), 20);
    expect(analyzeRules([B]).get(B.id)).toEqual({
      shadowedBy: null,
      neverMatches: true,
      invalid: false,
    });
  });
});

describe('emoji shadowing', () => {
  const e = (emoji: string[], maxCount: number | null = null) => ({
    type: 'emoji',
    emoji,
    maxCount,
  });
  it('subset of emoji is shadowed', () => {
    const A = r(e(['🤑', '💰']), 10);
    expect(shadow(A, r(e(['💰']), 20))).toBe(A.id);
  });
  it('skin tone variants share a key', () => {
    const A = r(e(['👍']), 10);
    expect(shadow(A, r(e(['👍🏽']), 20))).toBe(A.id);
  });
  it('extra emoji in B is not shadowed', () => {
    expect(shadow(r(e(['🤑']), 10), r(e(['🤑', '💰']), 20))).toBeNull();
  });
  it('maxCount rules', () => {
    const A = r(e(['🤑'], 5), 10);
    expect(shadow(A, r(e(['🤑'], 10), 20))).toBe(A.id);
    expect(shadow(A, r(e(['🤑'], null), 20))).toBe(A.id);
    expect(shadow(r(e(['🤑'], null), 10), r(e(['🤑'], 10), 20))).toBeNull();
    expect(shadow(r(e(['🤑'], 10), 10), r(e(['🤑'], 5), 20))).toBeNull();
  });
});

describe('author shadowing', () => {
  it('B ids subset of A ids, same platform', () => {
    const A = r(authors('block', [{ externalId: '1' }, { externalId: '2' }]), 10);
    expect(shadow(A, r(authors('block', [{ externalId: '2' }]), 20))).toBe(A.id);
    expect(shadow(A, r(authors('block', [{ externalId: '3' }]), 20))).toBeNull();
  });
  it('different platform is not shadowed', () => {
    const A = r(authors('block', [{ externalId: '1' }]), 10);
    const B = r({ ...authors('block', [{ externalId: '1' }]), platform: 'instagram' }, 20);
    expect(shadow(A, B)).toBeNull();
  });
  it('handle-only entries must be in A handle-only entries (normalised)', () => {
    const A = r(authors('block', [{ handle: '@Spammer' }]), 10);
    expect(shadow(A, r(authors('block', [{ handle: 'spammer' }]), 20))).toBe(A.id);
    expect(shadow(A, r(authors('block', [{ handle: 'other' }]), 20))).toBeNull();
  });
  it('an id on A does not cover a handle-only entry of B', () => {
    const A = r(authors('block', [{ externalId: '1', handle: 'spammer' }]), 10);
    expect(shadow(A, r(authors('block', [{ handle: 'spammer' }]), 20))).toBeNull();
  });
  it('trusted list at priority 9999 shadows a block list at priority 0', () => {
    const A = r(authors('trusted', [{ externalId: '1' }]), 9999, { actions: [] });
    const B = r(authors('block', [{ externalId: '1' }]), 0);
    expect(analyzeRules([B, A]).get(B.id)?.shadowedBy).toBe(A.id);
  });
});

describe('who can shadow', () => {
  it('dry-run rules never shadow', () => {
    expect(shadow(r(kw(['spam']), 10, { mode: 'suggest' }), r(kw(['spam']), 20))).toBeNull();
  });
  it('disabled rules never shadow', () => {
    expect(shadow(r(kw(['spam']), 10, { enabled: false }), r(kw(['spam']), 20))).toBeNull();
  });
  it('a later rule never shadows an earlier one', () => {
    const A = r(kw(['spam']), 20);
    const B = r(kw(['spam']), 10);
    expect(analyzeRules([A, B]).get(A.id)?.shadowedBy).toBe(B.id);
    expect(analyzeRules([A, B]).get(B.id)?.shadowedBy).toBeNull();
  });
  it('ties break by createdAt then id', () => {
    const A = r(kw(['spam']), 10, { createdAt: new Date(5) });
    const B = r(kw(['spam']), 10, { createdAt: new Date(9) });
    expect(analyzeRules([B, A]).get(B.id)?.shadowedBy).toBe(A.id);
  });
  it('legacy conditions are invalid and never shadow', () => {
    const legacy = r({ links: ['bit.ly'] }, 10);
    const B = r(links({ domains: ['bit.ly'] }), 20);
    const res = analyzeRules([legacy, B]);
    expect(res.get(legacy.id)).toEqual({ shadowedBy: null, neverMatches: false, invalid: true });
    expect(res.get(B.id)?.shadowedBy).toBeNull();
  });
  it('allow author list with a handle-only entry is invalid', () => {
    const x = r(authors('allow', [{ handle: 'x' }]), 10, { actions: [] });
    expect(analyzeRules([x]).get(x.id)?.invalid).toBe(true);
  });
  it('action/list mismatch is invalid and never shadows', () => {
    const A = r(authors('block', [{ externalId: '1' }]), 10, { actions: [] });
    const B = r(authors('block', [{ externalId: '1' }]), 20);
    expect(analyzeRules([A, B]).get(A.id)?.invalid).toBe(true);
    expect(analyzeRules([A, B]).get(B.id)?.shadowedBy).toBeNull();
  });
  it('the first covering earlier rule is reported', () => {
    const A1 = r(kw(['x']), 1);
    const A2 = r(kw(['spam']), 2);
    const A3 = r(kw(['spam']), 3);
    const B = r(kw(['spam']), 4);
    expect(analyzeRules([A1, A2, A3, B]).get(B.id)?.shadowedBy).toBe(A2.id);
  });
});
