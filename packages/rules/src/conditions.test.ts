import { describe, expect, it } from 'vitest';
import {
  checkActionForConditions,
  mapAuthorConditions,
  normalizeAuthorHandle,
  ruleConditionsSchema,
  ruleInputSchema,
  rulePatchSchema,
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
  const allow: RuleConditions = {
    type: 'author',
    list: 'allow',
    platform: 'facebook',
    entries: [{ externalId: '1' }],
  };
  const block: RuleConditions = { ...allow, list: 'block' };

  it('allow list with any step is rejected', () => {
    expect(checkActionForConditions(allow, [{ type: 'flag_for_review' }])).toMatch(/allow/i);
    expect(checkActionForConditions({ ...allow, list: 'trusted' }, [{ type: 'hide' }])).toMatch(
      /trusted/i,
    );
    expect(checkActionForConditions(allow, [])).toBeNull();
  });
  it('block list with only auto_reply is rejected', () => {
    expect(checkActionForConditions(block, [])).toMatch(/block/i);
    expect(checkActionForConditions(block, [{ type: 'auto_reply', template: 'Hi' }])).toMatch(
      /block/i,
    );
    expect(checkActionForConditions(block, [{ type: 'flag_for_review' }])).toBeNull();
  });
  it('other conditions accept any steps', () => {
    expect(checkActionForConditions({ type: 'keyword', terms: [], match: 'whole_word' }, [])).toBe(
      null,
    );
  });
  it('rule input accepts actions: name 1..200, mode defaults to suggest, enabled to true', () => {
    const r = ruleInputSchema.safeParse({
      name: ' Spam ',
      actions: [{ type: 'flag_for_review' }, { type: 'hide' }],
      conditions: { type: 'keyword', terms: ['x'] },
    });
    expect(r.success && r.data).toMatchObject({
      name: 'Spam',
      mode: 'suggest',
      enabled: true,
      actions: [{ type: 'flag_for_review' }, { type: 'hide' }],
    });
    expect(
      ruleInputSchema.safeParse({
        name: '',
        actions: [],
        conditions: { type: 'keyword', terms: [] },
      }).success,
    ).toBe(false);
  });
  it('rule input rejects the legacy action key and unconfirmed deletes', () => {
    const conditions = { type: 'keyword', terms: [] };
    expect(ruleInputSchema.safeParse({ name: 'x', action: 'hide', conditions }).success).toBe(
      false,
    );
    expect(
      ruleInputSchema.safeParse({ name: 'x', actions: [{ type: 'delete' }], conditions }).success,
    ).toBe(false);
  });
  it('rule patch accepts actions and rejects action', () => {
    expect(rulePatchSchema.safeParse({ actions: [{ type: 'hide' }] }).success).toBe(true);
    expect(rulePatchSchema.safeParse({ action: 'hide' }).success).toBe(false);
  });
});

describe('mapAuthorConditions', () => {
  const author = (entries: object[]) => ({ type: 'author', list: 'block', platform: 'facebook', entries });
  it('visits every author node at any depth and leaves the input untouched', () => {
    const input = { all: [author([{ externalId: '1' }]), { any: [author([{ handle: 'h' }])] }], n: 3 };
    const before = JSON.stringify(input);
    const seen: unknown[] = [];
    const out = mapAuthorConditions(input, (node) => {
      seen.push(node.entries);
      return { ...node, entries: [] };
    });
    expect(seen).toEqual([[{ externalId: '1' }], [{ handle: 'h' }]]);
    expect(out).toEqual({ all: [author([]), { any: [author([])] }], n: 3 });
    expect(JSON.stringify(input)).toBe(before);
  });
  it('ignores objects that only look like author nodes', () => {
    const fn = (n: never) => n;
    const v = { type: 'author', entries: 'x' };
    expect(mapAuthorConditions(v, fn)).toEqual(v);
    expect(mapAuthorConditions('author', fn)).toBe('author');
  });
});

describe('normalizeAuthorHandle', () => {
  it('compares handles the way the author matcher does', () => {
    expect(normalizeAuthorHandle('@Foo')).toBe('foo');
    expect(normalizeAuthorHandle('Zoë ')).toBe('zoe');
  });
});
