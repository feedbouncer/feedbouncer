import { describe, expect, it } from 'vitest';
import type { ConnectorCapabilities } from '@feedbouncer/connectors';
import { ACTION_KINDS } from './actions.js';
import {
  availabilityFor,
  evaluateEligibility,
  resolveConstraints,
  type EligibilityComment,
} from './eligibility.js';

const DAY = 86_400_000;
const now = new Date('2026-10-13T12:00:00Z');
const FB = {
  actions: ['hide', 'unhide', 'delete', 'ban_author', 'unban_author'],
  responses: ['public_reply', 'private_reply'],
} as unknown as ConnectorCapabilities;
const IG = {
  actions: ['hide', 'unhide', 'delete'],
  responses: ['public_reply', 'private_reply'],
  constraints: {
    privateReplyWindowMs: 7 * DAY,
    privateReplyTopLevelOnly: true,
    publicReplyOnHidden: false,
    hideOwnAccountComments: false,
    maxReplyChars: { public_reply: 2200, private_reply: 1000 },
  },
} as unknown as ConnectorCapabilities;
const c = (o: Partial<EligibilityComment> = {}): EligibilityComment => ({
  platformState: 'visible',
  isOwnAccount: false,
  hasAuthor: true,
  parentExternalId: null,
  postedAt: new Date(now.getTime() - DAY),
  privateReplied: false,
  ...o,
});

describe('evaluateEligibility', () => {
  it.each([
    ['IG ban is unsupported', IG, 'ban_author', 'user', c(), { verdict: 'unsupported' }],
    [
      'IG private reply on nested',
      IG,
      'private_reply',
      'user',
      c({ parentExternalId: '17800000000000000' }),
      { verdict: 'not_eligible', code: 'private_reply_nested_comment' },
    ],
    [
      'FB private reply on nested is fine',
      FB,
      'private_reply',
      'user',
      c({ parentExternalId: '1_2' }),
      { verdict: 'ok' },
    ],
    [
      'IG window closed exactly at 7d',
      IG,
      'private_reply',
      'user',
      c({ postedAt: new Date(now.getTime() - 7 * DAY) }),
      { verdict: 'not_eligible', code: 'private_reply_window_closed' },
    ],
    [
      'IG window open 1ms before 7d',
      IG,
      'private_reply',
      'user',
      c({ postedAt: new Date(now.getTime() - 7 * DAY + 1) }),
      { verdict: 'ok' },
    ],
    [
      'already privately replied',
      IG,
      'private_reply',
      'user',
      c({ privateReplied: true }),
      { verdict: 'not_eligible', code: 'private_reply_already_sent' },
    ],
    [
      'IG public reply on hidden',
      IG,
      'public_reply',
      'user',
      c({ platformState: 'hidden' }),
      { verdict: 'not_eligible', code: 'reply_to_hidden_comment' },
    ],
    [
      'FB public reply on hidden is fine',
      FB,
      'public_reply',
      'user',
      c({ platformState: 'hidden' }),
      { verdict: 'ok' },
    ],
    [
      'IG hide own comment',
      IG,
      'hide',
      'user',
      c({ isOwnAccount: true }),
      { verdict: 'not_eligible', code: 'own_comment_always_visible' },
    ],
    [
      'FB hide own comment is fine for a person',
      FB,
      'hide',
      'user',
      c({ isOwnAccount: true }),
      { verdict: 'ok' },
    ],
    [
      'rule on own comment',
      IG,
      'hide',
      'rule',
      c({ isOwnAccount: true }),
      { verdict: 'not_eligible', code: 'own_account_comment' },
    ],
    [
      'deleted wins',
      IG,
      'private_reply',
      'user',
      c({ platformState: 'deleted', parentExternalId: '1' }),
      { verdict: 'noop', code: 'already_deleted' },
    ],
    // Bans target the author, so a deleted comment does not make them moot (Facebook today).
    [
      'FB ban on a deleted comment is allowed',
      FB,
      'ban_author',
      'user',
      c({ platformState: 'deleted' }),
      { verdict: 'ok' },
    ],
    [
      'FB unban on a deleted comment is allowed',
      FB,
      'unban_author',
      'user',
      c({ platformState: 'deleted' }),
      { verdict: 'ok' },
    ],
    [
      'FB ban on a deleted page comment is still author_is_page',
      FB,
      'ban_author',
      'user',
      c({ platformState: 'deleted', isOwnAccount: true }),
      { verdict: 'not_eligible', code: 'author_is_page' },
    ],
    [
      'FB hide on hidden is noop',
      FB,
      'hide',
      'user',
      c({ platformState: 'hidden' }),
      { verdict: 'noop', code: 'already_hidden' },
    ],
    [
      'FB unhide on visible is noop',
      FB,
      'unhide',
      'user',
      c(),
      { verdict: 'noop', code: 'already_visible' },
    ],
    [
      'no author',
      IG,
      'private_reply',
      'user',
      c({ hasAuthor: false }),
      { verdict: 'not_eligible', code: 'author_unavailable' },
    ],
  ] as const)('%s', (_n, caps, kind, actorType, comment, expected) => {
    expect(evaluateEligibility({ kind, actorType, comment, caps, now })).toEqual(expected);
  });

  it('facebook defaults equal the previous hard-coded behaviour', () => {
    expect(resolveConstraints(FB)).toEqual({
      privateReplyWindowMs: 7 * DAY,
      privateReplyTopLevelOnly: false,
      publicReplyOnHidden: true,
      hideOwnAccountComments: true,
      maxReplyChars: { public_reply: 8000, private_reply: 8000 },
    });
  });

  it('instagram constraints come from the capabilities', () => {
    expect(resolveConstraints(IG)).toEqual({
      privateReplyWindowMs: 7 * DAY,
      privateReplyTopLevelOnly: true,
      publicReplyOnHidden: false,
      hideOwnAccountComments: false,
      maxReplyChars: { public_reply: 2200, private_reply: 1000 },
    });
  });

  it('availabilityFor agrees with evaluateEligibility for every kind', () => {
    for (const caps of [IG, FB])
      for (const comment of [
        c(),
        c({ platformState: 'hidden' }),
        c({ platformState: 'deleted' }),
        c({ parentExternalId: '1' }),
        c({ isOwnAccount: true }),
      ]) {
        const av = availabilityFor({ comment, caps, now });
        expect(Object.keys(av).sort()).toEqual([...ACTION_KINDS].sort());
        for (const kind of ACTION_KINDS) {
          const e = evaluateEligibility({ kind, actorType: 'user', comment, caps, now });
          expect(av[kind]).toEqual(
            e.verdict === 'ok'
              ? { available: true }
              : { available: false, reason: e.verdict === 'unsupported' ? 'unsupported' : e.code },
          );
        }
      }
  });
});
