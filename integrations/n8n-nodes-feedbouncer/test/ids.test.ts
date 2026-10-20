import { describe, expect, it } from 'vitest';
import { assertUuid, idempotencyKey, IDEMPOTENCY_KEY_PATTERN } from '../nodes/shared/ids';
import { fakeExecute } from './fakes';

describe('idempotencyKey', () => {
  it('joins the parts and replaces unsafe characters', () => {
    expect(idempotencyKey({ executionId: '123', nodeId: 'a b/c', runIndex: 1, itemIndex: 2, operation: 'hide', targetId: 'c1' }),
    ).toBe('n8n.123.a-b-c.1.2.hide.c1');
  });

  it('truncates to 128 characters and still matches the API pattern', () => {
    const key = idempotencyKey({ executionId: 'é'.repeat(300), nodeId: 'n', runIndex: 0, itemIndex: 0, operation: 'hide', targetId: 'c1' });
    expect(key).toHaveLength(128);
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });
});

describe('assertUuid', () => {
  const ctx = fakeExecute();
  const id = '3f2b8c1e-5d4a-4e7b-9a10-1c2d3e4f5a6b';

  it('returns a valid UUID unchanged', () => {
    expect(assertUuid(ctx, id, 'Comment ID')).toBe(id);
  });

  it.each(['../webhook-endpoints', '', 42, undefined, `${id}/x`])('rejects %j', (value) => {
    expect(() => assertUuid(ctx, value, 'Comment ID')).toThrow('Comment ID must be a FeedBouncer ID (a UUID).');
  });
});
