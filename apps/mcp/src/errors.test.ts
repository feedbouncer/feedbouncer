import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiCallError } from './api-client.js';
import { toToolError } from './errors.js';

const text = (e: unknown): string => {
  const r = toToolError(e);
  expect(r.isError).toBe(true);
  const first = r.content[0];
  return first?.type === 'text' ? first.text : '';
};

afterEach(() => vi.restoreAllMocks());

describe('toToolError', () => {
  const cases: [ApiCallError, string][] = [
    [
      new ApiCallError(404, 'not_found', 'Not found.'),
      'No comment/rule/brand with that ID in this workspace. List the inbox to get current IDs.',
    ],
    [
      new ApiCallError(422, 'unsupported_action', 'x', { platform: 'Instagram' }),
      'Instagram does not support this action.',
    ],
    [
      new ApiCallError(422, 'unsupported_action', 'x'),
      'This platform does not support this action.',
    ],
    [
      new ApiCallError(429, 'rate_limited', 'x', undefined, 7),
      'Rate limited. Retry after 7 seconds.',
    ],
    [
      new ApiCallError(403, 'insufficient_scope', 'x'),
      "This API key is read-only. Create a write key on the organization's API keys page.",
    ],
    [
      new ApiCallError(422, 'text_too_long', 'x', { max: 2200 }),
      'Reply is longer than the platform allows (max 2200).',
    ],
    [
      new ApiCallError(422, 'reply_not_allowed', 'x', { reason: 'comment_is_own' }),
      'comment_is_own',
    ],
    [new ApiCallError(409, 'connection_inactive', 'x'), 'Reconnect the account in FeedBouncer.'],
    [
      new ApiCallError(422, 'rule_rejected', 'Duplicate rule.', { reason: 'duplicate' }),
      'Rule rejected (duplicate): Duplicate rule.',
    ],
    [new ApiCallError(401, 'unauthenticated', 'x'), 'The API key was rejected.'],
    [new ApiCallError(422, 'already_deleted', 'x'), 'The comment was deleted on the platform.'],
    [new ApiCallError(422, 'comment_gone', 'x'), 'The comment was deleted on the platform.'],
    [
      new ApiCallError(422, 'reply_to_hidden_comment', 'x', { platform: 'Instagram' }),
      'Instagram does not allow replies to hidden comments. Unhide the comment first.',
    ],
    [
      new ApiCallError(409, 'pending_limit_reached', 'x', { max: 20 }),
      'Too many pending rule changes for this brand (max 20); ask a person to approve or reject some.',
    ],
    [
      new ApiCallError(409, 'pending_limit_reached', 'x'),
      'Too many pending rule changes for this brand; ask a person to approve or reject some.',
    ],
    [
      new ApiCallError(409, 'rule_limit_reached', 'x', { max: 100 }),
      'This brand already has the maximum number of rules (100); archive a rule before adding another.',
    ],
    [
      new ApiCallError(422, 'idempotency_key_reused', 'x'),
      'That idempotency key was already used with different input; use a new key.',
    ],
    [
      new ApiCallError(400, 'invalid_request', 'The request is not valid.', {
        reason: 'to_before_from',
      }),
      'Invalid request: `to` must be after `from`.',
    ],
    [
      new ApiCallError(400, 'invalid_request', 'The request is not valid.', {
        reason: 'to_in_future',
      }),
      'Invalid request: `to` must not be in the future.',
    ],
    [
      new ApiCallError(400, 'invalid_request', 'The request is not valid.', {
        reason: 'something_new',
      }),
      'Invalid request (something_new).',
    ],
    [
      new ApiCallError(400, 'invalid_request', 'postedFrom must be before postedTo.'),
      'Invalid request: postedFrom must be before postedTo.',
    ],
    [new ApiCallError(400, 'teapot', 'x'), 'FeedBouncer API error (teapot).'],
  ];

  it.each(cases)('maps %s', (err, expected) => {
    const out = text(err);
    expect(out).toBe(expected);
    expect(out).not.toContain('fbk_');
    expect(out).not.toContain('Bearer');
    expect(out).not.toContain('my-secret-key');
  });

  it('does not echo the idempotency key back', () => {
    const out = text(
      new ApiCallError(422, 'idempotency_key_reused', 'x', { key: 'my-secret-key' }),
    );
    expect(out).not.toContain('my-secret-key');
  });

  it('hides unknown errors and logs them redacted to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(text(new Error('boom Bearer abc.def password=hunter2'))).toBe('Internal error');
    const logged = write.mock.calls.map(String).join('');
    expect(logged).toContain('boom');
    expect(logged).not.toContain('abc.def');
  });
});
