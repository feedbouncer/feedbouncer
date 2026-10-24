import { describe, expect, it } from 'vitest';
import { world } from './test-world.js';

describe('listComments', () => {
  it('maps comments, preserving emoji/RTL text and hidden state', async () => {
    const { fake, connector, ctx, itemId } = await world();
    fake.addComment(itemId, { text: '🔥🔥🔥', createdAtSec: 1_790_000_000, username: 'fan_1' });
    fake.addComment(itemId, { text: 'مرحبا', createdAtSec: 1_790_000_100, hidden: true });
    const page = await connector.listComments(ctx, {
      sourceExternalId: itemId,
      cursor: null,
      limit: 30,
    });
    expect(page.items.map((c) => [c.body, c.platformState])).toEqual([
      ['مرحبا', 'hidden'],
      ['🔥🔥🔥', 'visible'],
    ]);
    expect(page.items[0]!.permalink).toBeNull();
    expect(page.items[1]).toMatchObject({
      sourceExternalId: itemId,
      parentExternalId: null,
      replyCount: 0,
      postedAt: new Date(1_790_000_000_000),
      author: { displayName: 'fan_1', profileUrl: 'https://www.tiktok.com/@fan_1' },
    });
    expect(page.nextCursor).toBeNull();
  });

  it('a comment listed with status DELETED is deleted', async () => {
    const { fake, connector, ctx, itemId, tamper } = await world();
    fake.addComment(itemId, { text: 'gone', createdAtSec: 1_790_000_000 });
    tamper('business/comment/list', (d) => ({
      ...d,
      comments: (d.comments as Record<string, unknown>[]).map((c) => ({ ...c, status: 'DELETED' })),
    }));
    const page = await connector.listComments(ctx, {
      sourceExternalId: itemId,
      cursor: null,
      limit: 30,
    });
    expect(page.items.map((c) => c.platformState)).toEqual(['deleted']);
  });

  it('pages with a numeric cursor and clamps the limit to 30', async () => {
    const { fake, connector, ctx, itemId } = await world();
    for (let i = 0; i < 35; i++)
      fake.addComment(itemId, { text: `c${i}`, createdAtSec: 1_790_000_000 + i });
    const p1 = await connector.listComments(ctx, {
      sourceExternalId: itemId,
      cursor: null,
      limit: 100,
    });
    expect(p1.items).toHaveLength(30);
    expect(p1.nextCursor).toBe('30');
    const p2 = await connector.listComments(ctx, {
      sourceExternalId: itemId,
      cursor: '30',
      limit: 30,
    });
    expect(p2.items).toHaveLength(5);
    expect(p2.nextCursor).toBeNull();
  });

  it('reports reply_count on the comment', async () => {
    const { fake, connector, ctx, itemId } = await world();
    const { commentId } = fake.addComment(itemId, { text: 'top', createdAtSec: 1_790_000_000 });
    fake.addComment(itemId, { text: 'r', createdAtSec: 1_790_000_001, parentId: commentId });
    const page = await connector.listComments(ctx, {
      sourceExternalId: itemId,
      cursor: null,
      limit: 30,
    });
    expect(page.items.map((c) => c.replyCount)).toEqual([1]);
  });

  it('drops an item with a malformed comment_id and keeps the rest', async () => {
    const { fake, connector, ctx, itemId, tamper, log } = await world();
    fake.addComment(itemId, { text: 'a', createdAtSec: 1_790_000_000 });
    fake.addComment(itemId, { text: 'b', createdAtSec: 1_790_000_001 });
    tamper('business/comment/list', (d) => {
      const [first, ...rest] = d.comments as Record<string, unknown>[];
      return { ...d, comments: [{ ...first, comment_id: 'abc/../1' }, ...rest] };
    });
    const page = await connector.listComments(ctx, {
      sourceExternalId: itemId,
      cursor: null,
      limit: 30,
    });
    expect(page.items.map((c) => c.body)).toEqual(['a']);
    expect(log).toHaveBeenCalledWith('tiktok items skipped', { code: 'invalid_item', count: 1 });
    expect(JSON.stringify(log.mock.calls)).not.toContain('abc');
  });

  it('truncates the body to 10,000 code points', async () => {
    const { fake, connector, ctx, itemId } = await world();
    fake.addComment(itemId, { text: '😀'.repeat(12_000), createdAtSec: 1_790_000_000 });
    const page = await connector.listComments(ctx, {
      sourceExternalId: itemId,
      cursor: null,
      limit: 30,
    });
    expect(Array.from(page.items[0]!.body)).toHaveLength(10_000);
  });

  it('a 501-item comments array is invalid_tiktok_response', async () => {
    const { connector, ctx, itemId, tamper } = await world();
    tamper('business/comment/list', (d) => ({ ...d, comments: Array(501).fill({}) }));
    await expect(
      connector.listComments(ctx, { sourceExternalId: itemId, cursor: null, limit: 30 }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_tiktok_response' });
  });

  it('permission_denied listing one video is source_inaccessible, not auth_expired', async () => {
    const { fake, connector, ctx, itemId, businessId } = await world();
    fake.revokeScope(businessId, 'businessCommentList');
    await expect(
      connector.listComments(ctx, { sourceExternalId: itemId, cursor: null, limit: 30 }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'source_inaccessible' });
  });

  it('rejects a malformed source id before calling TikTok', async () => {
    const { fake, connector, ctx } = await world();
    await expect(
      connector.listComments(ctx, { sourceExternalId: 'a/b', cursor: null, limit: 30 }),
    ).rejects.toMatchObject({ code: 'invalid_tiktok_id' });
    expect(fake.calls('businessCommentList')).toHaveLength(0);
  });
});

describe('listReplies', () => {
  it('returns replies with parentExternalId set', async () => {
    const { fake, connector, ctx, itemId } = await world();
    const { commentId } = fake.addComment(itemId, { text: 'top', createdAtSec: 1_790_000_000 });
    fake.addComment(itemId, { text: 'reply', createdAtSec: 1_790_000_001, parentId: commentId });
    const page = await connector.listReplies!(ctx, {
      parent: { sourceExternalId: itemId, externalId: commentId },
      cursor: null,
      limit: 30,
    });
    expect(page.items.map((c) => [c.body, c.parentExternalId])).toEqual([['reply', commentId]]);
  });

  it('permission_denied is source_inaccessible', async () => {
    const { fake, connector, ctx, itemId, businessId } = await world();
    const { commentId } = fake.addComment(itemId, { text: 'top', createdAtSec: 1_790_000_000 });
    fake.revokeScope(businessId, 'businessReplyList');
    await expect(
      connector.listReplies!(ctx, {
        parent: { sourceExternalId: itemId, externalId: commentId },
        cursor: null,
        limit: 30,
      }),
    ).rejects.toMatchObject({ code: 'source_inaccessible' });
  });
});

describe('getComment', () => {
  it('finds a top-level comment, and returns null for one that is gone', async () => {
    const { fake, connector, ctx, itemId } = await world();
    const { commentId } = fake.addComment(itemId, { text: 'hi', createdAtSec: 1_790_000_000 });
    const ref = { sourceExternalId: itemId, externalId: commentId };
    expect(await connector.getComment(ctx, ref)).toMatchObject({
      externalId: commentId,
      body: 'hi',
    });
    fake.deleteComment(commentId);
    expect(await connector.getComment(ctx, ref)).toBeNull();
  });
});
