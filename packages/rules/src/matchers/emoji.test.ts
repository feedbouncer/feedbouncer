import { expect, it } from 'vitest';
import { emojiConditions } from '../conditions.js';
import { CommentView } from '../view.js';
import { compileEmojiRule } from './emoji.js';

const v = (body: string) =>
  new CommentView({ body, platform: 'instagram', authorExternalId: null, authorName: null });
const b = { now: () => 0, startedAt: 0, limitMs: 50 };

it('matches a listed emoji regardless of skin tone', () => {
  const m = compileEmojiRule(emojiConditions.parse({ type: 'emoji', emoji: ['👍'] }));
  expect(m(v('nice 👍🏿'), b)).toEqual({ kind: 'emoji', emoji: '👍🏿' });
});
it('compares through emojiKey even when the list holds raw skin-tone variants', () => {
  const m = compileEmojiRule(emojiConditions.parse({ type: 'emoji', emoji: ['👍🏽', '👍'] }));
  expect(m(v('👍'), b)).toEqual({ kind: 'emoji', emoji: '👍' });
});
it('counts multi-codepoint emoji once for maxCount', () => {
  const m = compileEmojiRule(emojiConditions.parse({ type: 'emoji', emoji: [], maxCount: 2 }));
  expect(m(v('👨‍👩‍👧👨‍👩‍👧'), b)).toBeNull();
  expect(m(v('👨‍👩‍👧👨‍👩‍👧👍🏽'), b)).toEqual({ kind: 'emoji_count', count: 3, max: 2 });
});
it('an emoji-only comment is evaluated; an empty comment never matches', () => {
  const m = compileEmojiRule(emojiConditions.parse({ type: 'emoji', emoji: [], maxCount: 0 }));
  expect(m(v('🔥'), b)).toMatchObject({ kind: 'emoji_count', count: 1 });
  expect(m(v(''), b)).toBeNull();
});
