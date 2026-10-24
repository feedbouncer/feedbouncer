import { expect, it } from 'vitest';
import { regexConditions } from '../conditions.js';
import { CommentView } from '../view.js';
import { compileRegexRule } from './regex.js';

const v = (body: string) =>
  new CommentView({
    body,
    platform: 'facebook',
    authorExternalId: null,
    authorName: null,
    origin: 'organic',
  });

it('runs patterns against normalised text and reports the index', () => {
  const m = compileRegexRule(
    regexConditions.parse({ type: 'regex', patterns: ['^nope$', 'whats?app\\s*\\+?\\d{6,}'] }),
  );
  expect(m(v('WhatsApp +4479460000'), { now: () => 0, startedAt: 0, limitMs: 50 })).toEqual({
    kind: 'regex',
    patternIndex: 1,
  });
});
it('returns timeout when the budget is exceeded between patterns', () => {
  let t = 0;
  const m = compileRegexRule(regexConditions.parse({ type: 'regex', patterns: ['a', 'b', 'c'] }));
  expect(m(v('zzz'), { now: () => (t += 30), startedAt: 0, limitMs: 50 })).toBe('timeout');
});
it('empty pattern list never matches', () => {
  const m = compileRegexRule(regexConditions.parse({ type: 'regex', patterns: [] }));
  expect(m(v('x'), { now: () => 0, startedAt: 0, limitMs: 50 })).toBeNull();
});
