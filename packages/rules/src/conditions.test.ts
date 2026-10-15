import { describe, expect, it } from 'vitest';
import {
  checkActionForConditions,
  ruleConditionsSchema,
  ruleInputSchema,
  type RuleConditions,
} from './conditions.js';

const parse = (c: unknown) => ruleConditionsSchema.safeParse(c);

describe('ruleConditionsSchema', () => {
  it('defaults keyword match to whole_word and allows an empty list', () => {
    const r = parse({ type: 'keyword', terms: [] });
    expect(r.success && r.data).toEqual({ type: 'keyword', terms: [], match: 'whole_word' });
  });
  it('trims, drops blank and de-duplicates keyword terms', () => {
    const r = parse({ type: 'keyword', terms: [' Free ', 'free', '', 'money'] });
    expect(r.success && r.data.type === 'keyword' && r.data.terms).toEqual(['Free', 'money']);
  });
  it('rejects more than 5000 terms and terms over 100 chars', () => {
    expect(
      parse({ type: 'keyword', terms: Array.from({ length: 5001 }, (_, i) => `t${i}`) }).success,
    ).toBe(false);
    expect(parse({ type: 'keyword', terms: ['x'.repeat(101)] }).success).toBe(false);
  });
  it('validates regex patterns with RE2 and reports the failing index', () => {
    const r = parse({ type: 'regex', patterns: ['ok', '(a)\\1'] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('"patterns",1');
  });
  it('does not leak pattern text into regex issues', () => {
    const r = parse({ type: 'regex', patterns: ['(secretterm'] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain('secretterm');
  });
  it('normalises link domains to ASCII and rejects invalid ones', () => {
    const r = parse({
      type: 'link_domain',
      mode: 'blocklist',
      domains: ['https://Bit.ly/x', 'español.com'],
    });
    expect(r.success && r.data).toMatchObject({
      domains: ['bit.ly', 'xn--espaol-zwa.com'],
      exemptOwnDomains: true,
      shorteners: 'match',
      lookalikes: 'match',
    });
    expect(parse({ type: 'link_domain', mode: 'blocklist', domains: ['nope'] }).success).toBe(
      false,
    );
  });
  it('emoji rule needs a list or a max count; entries must be single emoji', () => {
    expect(parse({ type: 'emoji', emoji: [], maxCount: null }).success).toBe(false);
    expect(parse({ type: 'emoji', emoji: ['👍🏽', '👨‍👩‍👧'], maxCount: null }).success).toBe(true);
    expect(parse({ type: 'emoji', emoji: ['ab'], maxCount: null }).success).toBe(false);
    expect(parse({ type: 'emoji', emoji: [], maxCount: 5 }).success).toBe(true);
  });
  it('author entries need an id or a handle; handle "@" is stripped', () => {
    const r = parse({
      type: 'author',
      list: 'block',
      platform: 'instagram',
      entries: [{ handle: '@Spammer' }, { externalId: '178' }],
    });
    expect(r.success && r.data.type === 'author' && r.data.entries).toEqual([
      { handle: 'Spammer' },
      { externalId: '178' },
    ]);
    expect(
      parse({ type: 'author', list: 'block', platform: 'instagram', entries: [{}] }).success,
    ).toBe(false);
    expect(
      parse({ type: 'author', list: 'block', platform: 'myspace', entries: [{ handle: 'x' }] })
        .success,
    ).toBe(false);
  });
  it('competitor needs at least one name, handle or domain', () => {
    expect(parse({ type: 'competitor', names: [], handles: [], domains: [] }).success).toBe(false);
    expect(
      parse({ type: 'competitor', names: ['Acme'], handles: ['@acme'], domains: ['acme.com'] })
        .success,
    ).toBe(true);
  });
  it('rejects unknown types and extra keys', () => {
    expect(parse({ type: 'sentiment' }).success).toBe(false);
    expect(parse({ type: 'keyword', terms: [], extra: 1 }).success).toBe(false);
  });
});

describe('checkActionForConditions / ruleInputSchema', () => {
  it('allow and trusted author lists must approve; block lists must not', () => {
    const allow: RuleConditions = {
      type: 'author',
      list: 'allow',
      platform: 'facebook',
      entries: [{ externalId: '1' }],
    };
    expect(checkActionForConditions(allow, 'hide')).toMatch(/allow/i);
    expect(checkActionForConditions(allow, 'approve')).toBeNull();
    expect(checkActionForConditions({ ...allow, list: 'block' }, 'approve')).toMatch(/block/i);
  });
  it('rule input: name 1..200, mode defaults to suggest (dry run), enabled defaults to true', () => {
    const r = ruleInputSchema.safeParse({
      name: ' Spam ',
      action: 'hide',
      conditions: { type: 'keyword', terms: ['x'] },
    });
    expect(r.success && r.data).toMatchObject({ name: 'Spam', mode: 'suggest', enabled: true });
    expect(
      ruleInputSchema.safeParse({
        name: '',
        action: 'hide',
        conditions: { type: 'keyword', terms: [] },
      }).success,
    ).toBe(false);
    expect(
      ruleInputSchema.safeParse({
        name: 'x',
        action: 'delete',
        conditions: { type: 'keyword', terms: [] },
      }).success,
    ).toBe(false);
  });
});
