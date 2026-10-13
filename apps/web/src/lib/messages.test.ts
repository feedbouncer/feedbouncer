import { describe, expect, it } from 'vitest';
import {
  actionKindText,
  actorTypeText,
  messageFor,
  outcomeText,
  statusReasonText,
} from './messages';

const FALLBACK = messageFor('definitely_not_a_code');

describe('messageFor', () => {
  it.each([
    'platform_not_configured',
    'platform_error',
    'connection_needs_reconnect',
    'connection_inactive',
    'unsupported_action',
    'request_key_conflict',
    'service_unavailable',
    'account_mismatch',
    'denied',
    'missing_permissions',
    'oauth_rejected',
  ])('has a specific message for %s', (code) => {
    expect(messageFor(code)).not.toBe(FALLBACK);
  });
});

describe('outcomeText', () => {
  it.each([
    'already_hidden',
    'already_visible',
    'already_deleted',
    'comment_gone',
    'own_account_comment',
    'author_is_page',
    'author_unavailable',
    'author_not_bannable',
    'ban_limit_reached',
    'reblock_too_soon',
    'private_reply_window_closed',
    'private_reply_already_sent',
    'connected_elsewhere',
    'not_eligible',
    'not_found',
    'connection_inactive',
  ])('has a specific text for %s', (code) => {
    expect(outcomeText(code)).not.toBe(outcomeText('definitely_not_a_code'));
  });
});

describe('statusReasonText', () => {
  it('returns null for no reason', () => {
    expect(statusReasonText(null)).toBeNull();
  });
  it.each(['oauth_not_refreshable', 'oauth_access_rejected', 'page_role_lost'])(
    'has a specific text for %s',
    (code) => {
      expect(statusReasonText(code)).not.toBe(statusReasonText('definitely_not_a_code'));
    },
  );
  it('does not read inherited object keys', () => {
    expect(statusReasonText('constructor')).toBe(statusReasonText('definitely_not_a_code'));
  });
});

describe('actionKindText', () => {
  it.each([
    'hide',
    'unhide',
    'delete',
    'ban_author',
    'unban_author',
    'public_reply',
    'private_reply',
  ])('has a label for %s', (k) => {
    expect(actionKindText(k)).not.toBe(actionKindText('definitely_not_a_kind'));
    expect(actionKindText(k)).not.toBe(k);
  });
  it('falls back to a neutral label', () => {
    expect(actionKindText('toString')).toBe('Action');
    expect(actionKindText('weird')).toBe('Action');
  });
});

describe('actorTypeText', () => {
  it.each(['user', 'rule', 'classifier', 'system'])('has a label for %s', (a) => {
    expect(actorTypeText(a)).not.toBe(actorTypeText('definitely_not_an_actor'));
  });
  it('falls back to a neutral label', () => {
    expect(actorTypeText('weird')).toBe('someone');
  });
});
