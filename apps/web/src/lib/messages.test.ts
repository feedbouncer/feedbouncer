import { describe, expect, it } from 'vitest';
import {
  actionKindText,
  actorTypeText,
  messageFor,
  outcomeSentence,
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
    'invalid_rule',
    'rule_limit_reached',
    'rule_order_mismatch',
    'invalid_policy',
    'policy_limit_reached',
    'policy_name_taken',
    'policy_quota_exhausted',
    'policy_preview_in_progress',
    'policy_run_too_soon',
    'policy_not_enabled',
    'policy_evaluation_unavailable',
    'invalid_domain',
    'domain_exists',
    'domain_limit_reached',
    'invalid_tag_name',
    'tag_name_taken',
    'tag_limit_reached',
    'tag_count_changed',
    'unknown_tag',
    'invalid_timezone',
    'invalid_week',
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
  it.each(['oauth_not_refreshable', 'oauth_access_rejected', 'page_role_lost', 'setup_not_queued'])(
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

describe('instagram and platform-neutral codes', () => {
  it.each([
    [
      'own_comment_always_visible',
      "Instagram always shows your own comments, so they can't be hidden.",
    ],
    [
      'reply_to_hidden_comment',
      "Instagram doesn't allow replies to hidden comments. Unhide it first.",
    ],
    [
      'private_reply_nested_comment',
      'Instagram only allows private replies to top-level comments.',
    ],
    [
      'private_reply_not_permitted',
      'Private replies need the messaging permission. Reconnect and allow it.',
    ],
    ['reply_too_long', 'Reply is too long for this platform.'],
    ['text_too_long', 'Reply is too long for this platform.'],
    ['permission_revoked', 'FeedBouncer lost permission for this account. Reconnect it.'],
    [
      'instagram_account_restricted',
      'Instagram has restricted this account. Open the Instagram app to resolve it.',
    ],
    ['unsupported', 'Not available on this platform.'],
    ['platform_not_configured', "This platform isn't set up on this FeedBouncer server."],
  ])('outcome %s has its text', (code, text) => {
    expect(outcomeText(code)).toBe(text);
  });

  it.each([
    ['platform_not_configured', "This platform isn't set up on this FeedBouncer server."],
    ['platform_error', 'The platform could not be reached. Try again.'],
    ['text_too_long', 'Reply is too long for this platform.'],
  ])('message %s has its text', (code, text) => {
    expect(messageFor(code)).toBe(text);
  });

  it('formats an Instagram error code with its subcode', () => {
    expect(outcomeText('instagram_error_190_0')).toBe(
      'Instagram refused this action (error 190/0).',
    );
    expect(outcomeText('instagram_error_10_2207051')).toContain('error 10/2207051');
  });

  it('does not format a malformed Instagram error code', () => {
    expect(outcomeText('instagram_error_<b>_1')).toBe(outcomeText('definitely_not_a_code'));
    expect(outcomeText('instagram_error_1')).toBe(outcomeText('definitely_not_a_code'));
  });

  it('has an Instagram variant of connected_elsewhere', () => {
    expect(outcomeText('connected_elsewhere', 'instagram')).toBe(
      'This Instagram account is already connected in another FeedBouncer workspace.',
    );
    expect(outcomeText('connected_elsewhere', 'facebook')).toBe(outcomeText('connected_elsewhere'));
  });
});

describe('outcomeSentence', () => {
  it('turns a fragment into a sentence', () => {
    expect(outcomeSentence('comment_gone')).toBe('The comment no longer exists.');
  });
  it('explains why an action is unavailable on a connection that cannot act', () => {
    expect(outcomeSentence('connection_needs_reconnect')).toBe(
      'This connection needs to be reconnected first.',
    );
    expect(outcomeSentence('connection_inactive')).toBe('This connection is not active.');
  });
  it('keeps a full sentence unchanged', () => {
    expect(outcomeSentence('reply_to_hidden_comment')).toBe(
      "Instagram doesn't allow replies to hidden comments. Unhide it first.",
    );
  });
});

describe('connect failures', () => {
  it('names the tester invitation for provider_error', () => {
    expect(messageFor('provider_error')).toContain('tester invitation');
    expect(messageFor('provider_error')).toContain('connect again');
  });

  it('tells the user to reconnect for refresh and credential failures', () => {
    expect(statusReasonText('oauth_refresh_rejected')).toContain('Reconnect');
    expect(statusReasonText('credential_decrypt_failed')).toContain('Reconnect');
  });
});

describe('Threads outcomes', () => {
  it.each([
    [
      'hide_nested_reply_unsupported',
      'Threads can only hide replies made directly to your post. Hiding that reply also hides this one.',
    ],
    ['threads_error_100', 'Threads refused this action (code 100).'],
  ])('%s reads as a full sentence', (code, text) => {
    expect(outcomeText(code)).toBe(text);
    expect(outcomeSentence(code)).toBe(text);
  });

  it('does not format a malformed Threads error code', () => {
    expect(outcomeText('threads_error_<b>')).toBe(outcomeText('definitely_not_a_code'));
    expect(outcomeText('threads_error_')).toBe(outcomeText('definitely_not_a_code'));
  });

  // reply_quota_exhausted and rate_limit_exhausted are fragments (like every other
  // entry in OUTCOMES), because callers prepend their own prefix: "Delayed until
  // <time>: " in the comment history, "<StatusLabel>: " in the action log. A full
  // sentence here would read as a doubled-up prefix in both places.
  it('reply_quota_exhausted is a lowercase fragment with no "Delayed" prefix of its own', () => {
    const text = outcomeText('reply_quota_exhausted');
    expect(text).not.toMatch(/^Delayed/);
    expect(text).toContain("Threads' daily limit of 1,000 replies is reached");
  });

  it('rate_limit_exhausted stays generic across platforms and action kinds', () => {
    const text = outcomeText('rate_limit_exhausted');
    expect(text).not.toMatch(/^Not sent/);
    expect(text).not.toMatch(/24 hours/);
    expect(outcomeText('rate_limit_exhausted', 'facebook')).toBe(text);
  });

  it('throttled has its own text instead of the generic fallback', () => {
    expect(outcomeText('throttled')).not.toBe(outcomeText('definitely_not_a_code'));
  });
});
