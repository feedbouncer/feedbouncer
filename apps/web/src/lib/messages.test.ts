import { describe, expect, it } from 'vitest';
import { messageFor, outcomeText } from './messages';

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
    'connection_inactive',
  ])('has a specific text for %s', (code) => {
    expect(outcomeText(code)).not.toBe(outcomeText('definitely_not_a_code'));
  });
});
