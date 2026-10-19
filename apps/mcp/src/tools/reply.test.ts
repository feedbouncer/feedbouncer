import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiCallError } from '../api-client.js';
import { COMMENT_ID } from '../testing/fake-api.js';
import { connect, textOf, type Harness } from '../testing/harness.js';

let h: Harness;
afterEach(() => h.close());

const args = { commentId: COMMENT_ID, text: 'Thanks for the feedback!' };

describe('reply_to_comment', () => {
  it('returns the platform reply id when applied', async () => {
    h = await connect();
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBeFalsy();
    const action = [...h.api.posts.values()][0]!;
    expect(r.structuredContent).toEqual({
      status: 'posted',
      replyId: 'fb_reply_1',
      actionId: action.id,
    });
  });

  it('derives the same Idempotency-Key for the same text so only one post happens', async () => {
    h = await connect();
    await h.call('reply_to_comment', args);
    await h.call('reply_to_comment', args);
    const keys = h.api.callsTo('reply').map((c) => c[2]);
    const expected =
      'mcp-reply-' +
      createHash('sha256').update(`${COMMENT_ID}\n${args.text}`).digest('hex').slice(0, 40);
    expect(keys).toEqual([expected, expected]);
    expect(h.api.posts.size).toBe(1);
  });

  it('uses a caller-supplied Idempotency-Key', async () => {
    h = await connect();
    await h.call('reply_to_comment', { ...args, idempotencyKey: 'my-key.1' });
    expect(h.api.callsTo('reply')[0]![2]).toBe('my-key.1');
  });

  it('polls a pending action until it is applied', async () => {
    h = await connect();
    h.api.replyAction = { status: 'pending' };
    h.api.actionUpdates = [{ status: 'pending' }, { status: 'applied', platformRef: 'ig_9' }];
    const r = await h.call('reply_to_comment', args);
    expect(r.structuredContent).toMatchObject({ status: 'posted', replyId: 'ig_9' });
    expect(h.api.callsTo('getAction')).toHaveLength(2);
  });

  it('reports a failed action as an error and says nothing was posted', async () => {
    h = await connect();
    h.api.replyAction = { status: 'failed', code: 'comments_closed' };
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Nothing was posted.');
    expect(textOf(r)).toContain('comments_closed');
  });

  it('returns queued when still pending after the wait', async () => {
    h = await connect({ replyWaitMs: 50 });
    h.api.replyAction = { status: 'pending' };
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBeFalsy();
    const action = [...h.api.posts.values()][0]!;
    expect(r.structuredContent).toEqual({ status: 'queued', actionId: action.id });
    expect(textOf(r)).toContain('Queued; calling again with the same text will not post twice.');
  });

  it('names the platform when the action is unsupported', async () => {
    h = await connect();
    h.api.error = new ApiCallError(422, 'unsupported_action', 'Unsupported', {
      platform: 'Instagram',
    });
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Instagram does not support this action.');
  });

  it.each([
    { commentId: 'nope', text: 'hi' },
    { commentId: COMMENT_ID, text: '' },
    { commentId: COMMENT_ID, text: 'x'.repeat(8001) },
    { commentId: COMMENT_ID, text: 'hi', idempotencyKey: 'has space' },
  ])('rejects invalid input without calling the API', async (bad) => {
    h = await connect();
    const r = await h.call('reply_to_comment', bad);
    expect(r.isError).toBe(true);
    expect(h.api.calls).toEqual([]);
  });
});
