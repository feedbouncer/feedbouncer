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

  it('trims the text before sending it, as the API does', async () => {
    h = await connect();
    await h.call('reply_to_comment', { ...args, text: `  ${args.text}\n` });
    expect(h.api.callsTo('reply')[0]![1]).toBe(args.text);
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

  it('omits replyId when the platform returned no reference', async () => {
    h = await connect();
    h.api.replyAction = { status: 'applied', platformRef: null };
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ status: 'posted', actionId: expect.any(String) });
  });

  it('reports a failed action as an error and says nothing was posted', async () => {
    h = await connect();
    h.api.replyAction = { status: 'failed', code: 'comments_closed' };
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Nothing was posted.');
    expect(textOf(r)).toContain('comments_closed');
  });

  // The API keeps a refused or failed reply under its key, so retrying with the same key (or,
  // without one, the same text) returns the same refusal. The result must say to use a new key.
  const RETRY = 'To retry after fixing this, call again with a new idempotencyKey.';

  it.each([
    { status: 'failed' as const, code: 'platform_error' },
    { status: 'not_eligible' as const, code: 'reply_to_hidden_comment' },
  ])('tells the caller to retry a $status action with a new key', async (action) => {
    h = await connect();
    h.api.replyAction = action;
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBe(true);
    expect(textOf(r).split('\n').slice(-2)).toEqual(['Nothing was posted.', RETRY]);
    expect(r.structuredContent).toBeUndefined();
  });

  it.each([
    new ApiCallError(409, 'connection_inactive', 'x'),
    new ApiCallError(422, 'reply_not_allowed', 'x', { reason: 'review_mode_active' }),
    new ApiCallError(422, 'text_too_long', 'x', { max: 2200 }),
    new ApiCallError(422, 'unsupported_action', 'x', { platform: 'Instagram' }),
  ])('tells the caller to retry a refused reply ($code) with a new key', async (err) => {
    h = await connect();
    h.api.error = err;
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBe(true);
    expect(textOf(r).split('\n').slice(-2)).toEqual(['Nothing was posted.', RETRY]);
  });

  it.each([
    new ApiCallError(404, 'not_found', 'x'),
    new ApiCallError(429, 'rate_limited', 'x', undefined, 3),
    new ApiCallError(503, 'unreachable', 'x'),
  ])('does not suggest a new key for $code', async (err) => {
    h = await connect();
    h.api.error = err;
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain('idempotencyKey');
  });

  it('a success does not mention a new key', async () => {
    h = await connect();
    const r = await h.call('reply_to_comment', args);
    expect(textOf(r)).not.toContain('new idempotencyKey');
  });

  it('names an unknown platform as the API reports it', async () => {
    h = await connect();
    h.api.replyAction = { status: 'not_eligible', code: 'reply_to_hidden_comment' };
    h.api.replyComment = { platform: 'threads' };
    const r = await h.call('reply_to_comment', args);
    expect(textOf(r)).toContain('threads does not allow replies to hidden comments.');
  });

  it('says a deleted comment was not replied to', async () => {
    h = await connect();
    h.api.replyAction = { status: 'noop', code: 'already_deleted' };
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('The comment was deleted on the platform.\nNothing was posted.');
  });

  it('says retrying is safe when the status check fails after the reply was accepted', async () => {
    h = await connect();
    h.api.replyAction = { status: 'pending' };
    const getAction = h.api.getAction.bind(h.api);
    h.api.getAction = async (id) => {
      await getAction(id);
      throw new ApiCallError(503, 'unreachable', 'FeedBouncer API is unreachable');
    };
    const r = await h.call('reply_to_comment', args);
    expect(r.isError).toBe(true);
    const action = [...h.api.posts.values()][0]!;
    expect(textOf(r)).toContain(`The reply was accepted (action ${action.id})`);
    expect(textOf(r)).toContain('Retrying with the same text is safe; it will not post twice.');
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
    { commentId: COMMENT_ID, text: '   \n\t ' },
    { commentId: COMMENT_ID, text: 'x'.repeat(8001) },
    { commentId: COMMENT_ID, text: 'hi', idempotencyKey: 'has space' },
  ])('rejects invalid input without calling the API', async (bad) => {
    h = await connect();
    const r = await h.call('reply_to_comment', bad);
    expect(r.isError).toBe(true);
    expect(h.api.calls).toEqual([]);
  });
});
