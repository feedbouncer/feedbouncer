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
      'This API key is read-only. Create a write key in Settings → API keys.',
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
      new ApiCallError(409, 'pending_limit_reached', 'x'),
      'FeedBouncer API error (pending_limit_reached).',
    ],
  ];

  it.each(cases)('maps %s', (err, expected) => {
    const out = text(err);
    expect(out).toBe(expected);
    expect(out).not.toContain('fbk_');
    expect(out).not.toContain('Bearer');
  });

  it('hides unknown errors and logs them redacted to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(text(new Error('boom Bearer abc.def password=hunter2'))).toBe('Internal error');
    const logged = write.mock.calls.map(String).join('');
    expect(logged).toContain('boom');
    expect(logged).not.toContain('abc.def');
  });
});
