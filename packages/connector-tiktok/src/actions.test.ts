import { describe, expect, it } from 'vitest';
import { world } from './test-world.js';

async function withComment() {
  const w = await world();
  const { commentId } = w.fake.addComment(w.itemId, {
    text: 'secret words',
    createdAtSec: 1_790_000_000,
  });
  return { ...w, commentId, target: { sourceExternalId: w.itemId, externalId: commentId } };
}

describe('act', () => {
  it('hide then unhide flips TikTok state and returns request id', async () => {
    const { fake, connector, ctx, commentId, target } = await withComment();
    const hidden = await connector.act(ctx, { action: 'hide', target });
    expect(hidden).toMatchObject({
      status: 'applied',
      platformActionId: expect.stringMatching(/^req\d+$/),
    });
    expect(fake.commentState(commentId)).toBe('HIDDEN');
    await connector.act(ctx, { action: 'unhide', target });
    expect(fake.commentState(commentId)).toBe('PUBLIC');
  });

  it('delete removes the comment', async () => {
    const { fake, connector, ctx, commentId, target } = await withComment();
    await expect(connector.act(ctx, { action: 'delete', target })).resolves.toMatchObject({
      status: 'applied',
    });
    expect(fake.commentState(commentId)).toBe('DELETED');
  });

  it('delete of a comment deleted on TikTok returns not_found', async () => {
    const { fake, connector, ctx, commentId, target } = await withComment();
    fake.deleteComment(commentId);
    await expect(connector.act(ctx, { action: 'delete', target })).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('an unsupported action is refused without calling TikTok', async () => {
    const { fake, connector, ctx, target } = await withComment();
    await expect(connector.act(ctx, { action: 'ban_author', target })).rejects.toMatchObject({
      kind: 'unsupported',
    });
    expect(fake.calls('businessCommentHide')).toHaveLength(0);
  });

  it('missing manage scope on act is scope_missing with comment.list.manage', async () => {
    const { fake, connector, ctx, businessId, target } = await withComment();
    fake.revokeScope(businessId, 'businessCommentHide');
    await expect(connector.act(ctx, { action: 'hide', target })).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'scope_missing',
      reauthorize: true,
      missingScopes: ['comment.list.manage'],
    });
  });

  it('throttle on act is rate_limited', async () => {
    const { fake, connector, ctx, target } = await withComment();
    fake.throttleNext('businessCommentHide', 1);
    await expect(connector.act(ctx, { action: 'hide', target })).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });
});

describe('respond', () => {
  it('public_reply posts the text and never logs it', async () => {
    const { fake, connector, ctx, commentId, target, log } = await withComment();
    const r = await connector.respond!(ctx, {
      kind: 'public_reply',
      target,
      text: 'thanks, unique-reply-text',
    });
    expect(r).toMatchObject({ status: 'sent', platformRef: expect.stringMatching(/^\d+$/) });
    expect(fake.replies(commentId)).toEqual([{ text: 'thanks, unique-reply-text' }]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('unique-reply-text');
  });

  it('a reply to a deleted comment is not_found', async () => {
    const { fake, connector, ctx, commentId, target } = await withComment();
    fake.deleteComment(commentId);
    await expect(
      connector.respond!(ctx, { kind: 'public_reply', target, text: 'x' }),
    ).resolves.toEqual({ status: 'not_found' });
  });

  it('missing manage scope on respond is scope_missing', async () => {
    const { fake, connector, ctx, businessId, target } = await withComment();
    fake.revokeScope(businessId, 'businessReplyCreate');
    await expect(
      connector.respond!(ctx, { kind: 'public_reply', target, text: 'x' }),
    ).rejects.toMatchObject({
      code: 'scope_missing',
      missingScopes: ['comment.list.manage'],
    });
  });

  it('private_reply is unsupported', async () => {
    const { connector, ctx, target } = await withComment();
    await expect(
      connector.respond!(ctx, { kind: 'private_reply', target, text: 'x' }),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });
});
