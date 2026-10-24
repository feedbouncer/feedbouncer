import { expect, it } from 'vitest';
import { authorConditions } from '../conditions.js';
import { CommentView } from '../view.js';
import { compileAuthorRule } from './author.js';

const b = { now: () => 0, startedAt: 0, limitMs: 50 };
const view = (
  id: string | null,
  name: string | null,
  platform: 'facebook' | 'instagram' = 'instagram',
) =>
  new CommentView({
    body: 'x',
    platform,
    authorExternalId: id,
    authorName: name,
    origin: 'organic',
  });
const m = compileAuthorRule(
  authorConditions.parse({
    type: 'author',
    list: 'block',
    platform: 'instagram',
    entries: [{ externalId: '178', handle: 'old_name' }, { handle: '@Spam.Bot' }],
  }),
);

it('matches on ID first, so a renamed author is still blocked', () => {
  expect(m(view('178', 'brand_new_name'), b)).toEqual({
    kind: 'author',
    list: 'block',
    matchedOn: 'id',
  });
});
it('an entry with an ID does not match someone else who took the old handle', () => {
  expect(m(view('999', 'old_name'), b)).toBeNull();
});
it('handle-only entries match case-insensitively without the @', () => {
  expect(m(view('555', 'spam.bot'), b)).toEqual({
    kind: 'author',
    list: 'block',
    matchedOn: 'handle',
  });
});
it('is per platform and ignores missing authors', () => {
  expect(m(view('178', null, 'facebook'), b)).toBeNull();
  expect(m(view(null, null), b)).toBeNull();
});

const trusted = compileAuthorRule(
  authorConditions.parse({
    type: 'author',
    list: 'trusted',
    platform: 'instagram',
    entries: [{ externalId: '42', handle: 'the_owner' }],
  }),
);
it('trusted/allow lists match only the stable id, never a display name', () => {
  expect(trusted(view('42', 'anything'), b)).toEqual({
    kind: 'author',
    list: 'trusted',
    matchedOn: 'id',
  });
  expect(trusted(view('999', 'the_owner'), b)).toBeNull();
  expect(trusted(view('999', '@The_Owner'), b)).toBeNull();
  expect(trusted(view('42', 'x', 'facebook'), b)).toBeNull();
});
it('a null or empty author id never matches', () => {
  expect(trusted(view(null, 'the_owner'), b)).toBeNull();
  expect(trusted(view('', 'the_owner'), b)).toBeNull();
  expect(m(view('', null), b)).toBeNull();
});
it('allow/trusted entries without an id are rejected', () => {
  for (const list of ['allow', 'trusted']) {
    const r = authorConditions.safeParse({
      type: 'author',
      list,
      platform: 'instagram',
      entries: [{ externalId: '1' }, { handle: 'owner' }],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/need the author's ID/);
  }
});
it('never matches facts without a platform', () => {
  const fb = compileAuthorRule(
    authorConditions.parse({
      type: 'author',
      list: 'block',
      platform: 'facebook',
      entries: [{ externalId: '123' }],
    }),
  );
  const v = new CommentView({
    body: 'x',
    platform: null,
    authorExternalId: '123',
    authorName: null,
    origin: 'organic',
  });
  expect(fb(v, b)).toBeNull();
});
