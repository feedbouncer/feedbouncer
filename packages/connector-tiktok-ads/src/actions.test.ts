import { describe, expect, it } from 'vitest';
import { createTikTokConnector } from '@feedbouncer/connector-tiktok';
import { createSafeHttp } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { TIKTOK_API_HOST } from '@feedbouncer/tiktok-business-api';
import { AD_COMMENT_HIDE_FIELD } from './config.js';
import { NOW, world } from './test-world.js';

async function withComment() {
  const w = await world();
  const { commentId } = w.fake.addAdComment(w.advertiserId, {
    adId: '111',
    itemId: '900',
    text: 'secret words',
    createdAt: new Date(NOW.getTime() - 86400_000),
  });
  return { ...w, commentId, target: { sourceExternalId: '111', externalId: commentId } };
}

describe('act', () => {
  it('hide sends the AD_COMMENT_HIDE_FIELD with HIDDEN; unhide sends PUBLIC', async () => {
    const { fake, connector, ctx, commentId, target, advertiserId } = await withComment();
    await expect(connector.act(ctx, { action: 'hide', target })).resolves.toMatchObject({
      status: 'applied',
      platformActionId: expect.stringMatching(/^req\d+$/),
    });
    expect(fake.commentState(commentId)).toBe('HIDDEN');
    await connector.act(ctx, { action: 'unhide', target });
    expect(fake.commentState(commentId)).toBe('PUBLIC');
    expect(fake.calls('adCommentStatusUpdate').map((c) => c.body)).toEqual([
      { advertiser_id: advertiserId, comment_ids: [commentId], [AD_COMMENT_HIDE_FIELD]: 'HIDDEN' },
      { advertiser_id: advertiserId, comment_ids: [commentId], [AD_COMMENT_HIDE_FIELD]: 'PUBLIC' },
    ]);
  });

  it('delete removes the comment; deleting it again returns not_found', async () => {
    const { fake, connector, ctx, commentId, target } = await withComment();
    await expect(connector.act(ctx, { action: 'delete', target })).resolves.toMatchObject({
      status: 'applied',
    });
    expect(fake.commentState(commentId)).toBe('DELETED');
    await expect(connector.act(ctx, { action: 'delete', target })).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('delete of an already-deleted comment returns not_found', async () => {
    const { fake, connector, ctx, commentId, target } = await withComment();
    fake.deleteComment(commentId);
    await expect(connector.act(ctx, { action: 'hide', target })).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('an unsupported action is refused without calling TikTok', async () => {
    const { fake, connector, ctx, target } = await withComment();
    await expect(connector.act(ctx, { action: 'ban_author', target })).rejects.toMatchObject({
      kind: 'unsupported',
    });
    expect(fake.calls('adCommentStatusUpdate')).toHaveLength(0);
  });

  it('throttled hide is rate_limited', async () => {
    const { fake, connector, ctx, target } = await withComment();
    fake.throttleNext('adCommentStatusUpdate', 1);
    await expect(connector.act(ctx, { action: 'hide', target })).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });

  it('permission denied on act is scope_missing comment_management', async () => {
    const { fake, connector, ctx, advertiserId, target } = await withComment();
    fake.revokeScope(advertiserId, 'adCommentStatusUpdate');
    await expect(connector.act(ctx, { action: 'hide', target })).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'scope_missing',
      reauthorize: true,
      missingScopes: ['comment_management'],
    });
  });
});

describe('respond', () => {
  it('public_reply looks up the item id, posts the text and never logs it', async () => {
    const { fake, connector, ctx, commentId, target, log, advertiserId } = await withComment();
    const r = await connector.respond!(ctx, {
      kind: 'public_reply',
      target,
      text: 'thanks, unique-reply-text',
    });
    expect(r).toMatchObject({ status: 'sent', platformRef: expect.stringMatching(/^\d+$/) });
    expect(fake.replies(commentId)).toEqual([{ text: 'thanks, unique-reply-text' }]);
    expect(fake.calls('adCommentPost')[0]!.body).toEqual({
      advertiser_id: advertiserId,
      comment_type: 'REPLY',
      comment_id: commentId,
      ad_id: '111',
      tiktok_item_id: '900',
      text: 'thanks, unique-reply-text',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('unique-reply-text');
  });

  it('a reply to a comment that cannot be found is not_found without posting', async () => {
    const { fake, connector, ctx, commentId, target } = await withComment();
    fake.deleteComment(commentId);
    await expect(
      connector.respond!(ctx, { kind: 'public_reply', target, text: 'x' }),
    ).resolves.toEqual({ status: 'not_found' });
    expect(fake.calls('adCommentPost')).toHaveLength(0);
  });

  it('permission denied on respond is scope_missing', async () => {
    const { fake, connector, ctx, advertiserId, target } = await withComment();
    fake.revokeScope(advertiserId, 'adCommentPost');
    await expect(
      connector.respond!(ctx, { kind: 'public_reply', target, text: 'x' }),
    ).rejects.toMatchObject({ code: 'scope_missing', missingScopes: ['comment_management'] });
  });

  it('private_reply is unsupported', async () => {
    const { connector, ctx, target } = await withComment();
    await expect(
      connector.respond!(ctx, { kind: 'private_reply', target, text: 'x' }),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });
});

describe('product isolation', () => {
  it('marketing outage does not affect the organic connector', async () => {
    const w = await withComment();
    const organic = createTikTokConnector({
      appId: '7300000000000002',
      appSecret: 'tiktok-ads-SECRET-0123456789',
    });
    const http = createSafeHttp({ allowedHosts: [TIKTOK_API_HOST], fetch: w.fake.fetch });
    const oauth = { http, signal: w.signal, redirectUri: 'https://app.test/cb' };
    const { businessId, authCode } = w.fake.addBusinessAccount({ username: 'shop' });
    const { itemId } = w.fake.addVideo(businessId);
    w.fake.addComment(itemId, { text: 'organic', createdAtSec: 1_790_000_000 });
    const { tokens } = await organic.exchangeCode(
      { code: new Secret(authCode), codeVerifier: new Secret('v') },
      oauth,
    );
    w.fake.outage('marketing', true);
    await expect(
      w.connector.act(w.ctx, { action: 'hide', target: w.target }),
    ).rejects.toMatchObject({ kind: 'transient' });
    const page = await organic.listComments(
      { ...w.ctx, accessToken: tokens.accessToken, externalAccountId: businessId },
      { sourceExternalId: itemId, cursor: null, limit: 30 },
    );
    expect(page.items.map((c) => c.body)).toEqual(['organic']);
  });
});
