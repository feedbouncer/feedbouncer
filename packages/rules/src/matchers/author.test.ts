import { expect, it } from 'vitest';
import { authorConditions } from '../conditions.js';
import { CommentView } from '../view.js';
import { compileAuthorRule } from './author.js';

const b = { now: () => 0, startedAt: 0, limitMs: 50 };
const view = (
  id: string | null,
  name: string | null,
  platform: 'facebook' | 'instagram' = 'instagram',
) => new CommentView({ body: 'x', platform, authorExternalId: id, authorName: name });
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
