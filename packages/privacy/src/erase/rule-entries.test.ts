import { describe, expect, it } from 'vitest';
import type { RuleConditions } from '@feedbouncer/rules';
import { redactAuthorEntries, removeAuthorEntries, type EntryMatch } from './rule-entries.js';

const block = (entries: { externalId?: string; handle?: string }[], platform = 'facebook') =>
  ({ type: 'author', list: 'block', platform, entries }) as RuleConditions;
const match = (o: Partial<{ platform: 'facebook' | 'instagram'; ids: string[]; handles: string[] }>): EntryMatch => ({
  platform: o.platform ?? 'facebook',
  externalIds: new Set(o.ids ?? []),
  handles: new Set(o.handles ?? []),
});

describe('removeAuthorEntries', () => {
  it('removes one matching entry and keeps the rest', () => {
    const r = removeAuthorEntries(block([{ externalId: '1' }, { externalId: '2' }]), match({ ids: ['1'] }));
    expect(r).toEqual({ conditions: block([{ externalId: '2' }]), removed: 1, emptied: false });
  });
  it('reports emptied when the last entry goes', () => {
    const r = removeAuthorEntries(
      block([{ externalId: '1' }, { externalId: '2' }]),
      match({ ids: ['1', '2'] }),
    );
    expect(r).toEqual({ conditions: block([]), removed: 2, emptied: true });
  });
  it('walks a nested combinator tree', () => {
    const nested = {
      type: 'all',
      conditions: [block([{ externalId: '1' }, { externalId: '3' }]), { type: 'any', conditions: [block([{ externalId: '1' }])] }],
    } as unknown as RuleConditions;
    const r = removeAuthorEntries(nested, match({ ids: ['1'] }));
    expect(r.removed).toBe(2);
    expect(r.emptied).toBe(true);
    expect(r.conditions).toEqual({
      type: 'all',
      conditions: [block([{ externalId: '3' }]), { type: 'any', conditions: [block([])] }],
    });
  });
  it('leaves an entry on another platform untouched', () => {
    const c = block([{ externalId: '1' }], 'instagram');
    expect(removeAuthorEntries(c, match({ ids: ['1'] }))).toEqual({ conditions: c, removed: 0, emptied: false });
  });
  it('matches external ids exactly', () => {
    const c = block([{ externalId: 'abc' }, { externalId: 'ABC' }, { externalId: ' abc' }]);
    expect(removeAuthorEntries(c, match({ ids: ['a%', 'a_c', 'abc '] })).removed).toBe(0);
    expect(removeAuthorEntries(c, match({ ids: ['abc'] })).removed).toBe(1);
  });
  it("compares handles with the rules package's normalization", () => {
    const c = block([{ handle: 'foo' }, { handle: 'bar' }]);
    const r = removeAuthorEntries(c, match({ handles: ['@Foo'] }));
    expect(r).toEqual({ conditions: block([{ handle: 'bar' }]), removed: 1, emptied: false });
  });
  it('removes an entry when either its id or its handle matches', () => {
    const c = block([{ externalId: '9', handle: 'foo' }, { externalId: '1' }]);
    expect(removeAuthorEntries(c, match({ handles: ['foo'] })).removed).toBe(1);
  });
  it('leaves conditions of other kinds alone', () => {
    const c = { type: 'keyword', terms: ['1'], match: 'whole_word' } as RuleConditions;
    expect(removeAuthorEntries(c, match({ ids: ['1'] }))).toEqual({ conditions: c, removed: 0, emptied: false });
  });
});

describe('redactAuthorEntries', () => {
  it('replaces the id and handle of each matching entry with [erased], at any depth', () => {
    const snapshot = { name: 'r', conditions: block([{ externalId: '1', handle: 'foo' }, { externalId: '2' }]) };
    const diff = [{ field: 'conditions', before: block([{ handle: 'Foo' }]), after: block([]) }];
    const r = redactAuthorEntries({ snapshot, diff }, [match({ ids: ['1'], handles: ['foo'] })]);
    expect(r.redacted).toBe(2);
    expect(r.value).toEqual({
      snapshot: { name: 'r', conditions: block([{ externalId: '[erased]', handle: '[erased]' }, { externalId: '2' }]) },
      diff: [{ field: 'conditions', before: block([{ handle: '[erased]' }]), after: block([]) }],
    });
  });
  it('counts nothing when no entry matches', () => {
    expect(redactAuthorEntries(block([{ externalId: '2' }]), [match({ ids: ['1'] })]).redacted).toBe(0);
  });
});
