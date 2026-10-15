import { describe, expect, it } from 'vitest';
import { linkDomainConditions } from '../conditions.js';
import { CommentView } from '../view.js';
import { compileLinkRule } from './links.js';

const v = (body: string) =>
  new CommentView({ body, platform: 'facebook', authorExternalId: null, authorName: null });
const budget = { now: () => 0, startedAt: 0, limitMs: 50 };
const rule = (c: object, own: string[] = ['example.com']) =>
  compileLinkRule(linkDomainConditions.parse({ type: 'link_domain', ...c }), { ownDomains: own });

describe('link rule: allowlist', () => {
  const m = rule({ mode: 'allowlist', domains: ['partner.org'] });
  it('own domain, its www and subdomains always pass', () => {
    expect(m(v('https://www.example.com/x shop.example.com'), budget)).toBeNull();
  });
  it('allowlisted domains pass, others match', () => {
    expect(m(v('partner.org/a'), budget)).toBeNull();
    expect(m(v('evil.io'), budget)).toEqual({
      kind: 'link',
      host: 'evil.io',
      reason: 'not_allowlisted',
    });
  });
  it('lookalikes of the own domain are not exempt', () => {
    expect(m(v('example.com.evil.io'), budget)).toMatchObject({ host: 'example.com.evil.io' });
    expect(m(v('https://example.com@evil.io'), budget)).toMatchObject({ host: 'evil.io' });
    expect(m(v('https://еxample.com'), budget)).toMatchObject({ reason: 'lookalike' });
  });
  it('shorteners match with reason shortener (destination unknown, never resolved)', () => {
    expect(m(v('bit.ly/abc'), budget)).toEqual({
      kind: 'link',
      host: 'bit.ly',
      reason: 'shortener',
    });
  });
  it('no links -> no match', () => {
    expect(m(v('hello there'), budget)).toBeNull();
  });
  it('an own link next to a foreign one is still flagged on the foreign host', () => {
    expect(m(v('example.com and evil.io'), budget)).toMatchObject({ host: 'evil.io' });
  });
});

describe('link rule: blocklist', () => {
  it('matches blocked domains and their subdomains only', () => {
    const m = rule({ mode: 'blocklist', domains: ['evil.io'], shorteners: 'ignore' });
    expect(m(v('x.evil.io/y'), budget)).toMatchObject({ host: 'x.evil.io', reason: 'blocklisted' });
    expect(m(v('notevil.io'), budget)).toBeNull();
    expect(m(v('bit.ly/a'), budget)).toBeNull();
  });
  it('own domain exemption can be overridden', () => {
    const exempt = rule({ mode: 'blocklist', domains: ['example.com'] });
    expect(exempt(v('example.com'), budget)).toBeNull();
    const override = rule({ mode: 'blocklist', domains: ['example.com'], exemptOwnDomains: false });
    expect(override(v('example.com'), budget)).toMatchObject({ reason: 'blocklisted' });
  });
  it('the exemption applies only when every host is own: one foreign host removes it', () => {
    const m = rule({ mode: 'blocklist', domains: ['example.com'] });
    expect(m(v('example.com evil.io'), budget)).toMatchObject({
      host: 'example.com',
      reason: 'blocklisted',
    });
  });
  it('lookalike of a non-own domain matches when lookalikes=match', () => {
    const m = rule({ mode: 'blocklist', domains: [], shorteners: 'ignore' }, []);
    expect(m(v('https://раураl.com'), budget)).toMatchObject({ reason: 'lookalike' });
  });
  it('whole-script confusables (all Cyrillic) do not match: known limitation, needs UTS #39', () => {
    const m = rule({ mode: 'blocklist', domains: [], shorteners: 'ignore' }, []);
    expect(m(v('https://раура.com'), budget)).toBeNull();
  });
});

describe('link rule: truncated extraction fails closed only for allowlists', () => {
  const many = (n: number, own = false) =>
    Array.from({ length: n }, (_, i) => `h${i}.${own ? 'example.com' : 'ok.org'}`).join(' ');
  it('blocklist: truncation alone is not a match (no examined host is blocked)', () => {
    const m = rule({ mode: 'blocklist', domains: ['evil.io'] });
    expect(m(v(many(80)), budget)).toBeNull();
    expect(m(v(many(80, true)), budget)).toBeNull();
  });
  it('allowlist: truncated is a not_allowlisted match', () => {
    const m = rule({ mode: 'allowlist', domains: ['ok.org'] });
    expect(m(v(many(80)), budget)).toMatchObject({ kind: 'link', reason: 'not_allowlisted' });
  });
  it('an examined match wins over the truncation fallback', () => {
    const m = rule({ mode: 'blocklist', domains: ['evil.io'] });
    expect(m(v(`x.evil.io ${many(80)}`), budget)).toMatchObject({ host: 'x.evil.io' });
  });
});
