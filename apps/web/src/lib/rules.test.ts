import { describe, expect, it } from 'vitest';
import {
  ACTION_LABEL,
  conditionsFromForm,
  emptyForm,
  formFromConditions,
  linesToList,
  listToLines,
  type RuleFormState,
  type RuleKind,
} from './rules';

const CONDITIONS: Record<RuleKind, unknown> = {
  keyword: { type: 'keyword', terms: ['free money', 'crypto'], match: 'contains' },
  regex: { type: 'regex', patterns: ['a+b', 'c\\d'] },
  link_domain: {
    type: 'link_domain',
    mode: 'allowlist',
    domains: ['example.com', 'x.org'],
    exemptOwnDomains: false,
    shorteners: 'ignore',
    lookalikes: 'match',
  },
  emoji: { type: 'emoji', emoji: ['🔥', '💰'], maxCount: 3 },
  author: {
    type: 'author',
    list: 'block',
    platform: 'instagram',
    entries: [{ externalId: '12345' }, { handle: 'spammer' }, { externalId: '7', handle: 'old' }],
  },
  competitor: { type: 'competitor', names: ['Acme'], handles: ['acme'], domains: ['acme.com'] },
};

describe('conditions and form state', () => {
  it.each(Object.keys(CONDITIONS) as RuleKind[])('round-trips %s', (kind) => {
    const form = formFromConditions(CONDITIONS[kind]);
    expect(conditionsFromForm(kind, form)).toEqual(CONDITIONS[kind]);
  });

  it('uses a null max count when the field is empty', () => {
    const form: RuleFormState = { ...emptyForm(), emojiList: '🔥', emojiMaxCount: '' };
    expect(conditionsFromForm('emoji', form)).toEqual({
      type: 'emoji',
      emoji: ['🔥'],
      maxCount: null,
    });
  });

  it('falls back to an empty form for unknown conditions', () => {
    expect(formFromConditions({ type: 'nope' })).toEqual(emptyForm());
    expect(formFromConditions(null)).toEqual(emptyForm());
  });

  it('parses author lines with an ID, a handle or both', () => {
    const form: RuleFormState = {
      ...emptyForm(),
      authorEntries: 'id:12345\n@handle\nid:1 @old',
    };
    const c = conditionsFromForm('author', form) as { entries: unknown[] };
    expect(c.entries).toEqual([
      { externalId: '12345' },
      { handle: 'handle' },
      { externalId: '1', handle: 'old' },
    ]);
  });
});

describe('lists', () => {
  it('splits on newlines, trims and drops blanks', () => {
    expect(linesToList('a\n\n b \r\nc')).toEqual(['a', 'b', 'c']);
  });

  it('joins with newlines', () => {
    expect(listToLines(['a', 'b'])).toBe('a\nb');
  });
});

describe('labels', () => {
  it('shows stored words in the product vocabulary', () => {
    expect(ACTION_LABEL.remove).toBe('Delete');
    expect(ACTION_LABEL.approve).toBe('Allow');
    expect(ACTION_LABEL.flag).toBe('Flag for review');
    expect(ACTION_LABEL.hide).toBe('Hide');
  });
});
