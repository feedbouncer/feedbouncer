import { describe, expect, it } from 'vitest';
import {
  ConnectorError,
  createSafeHttp,
  type CallContext,
  type NormalizedComment,
  type Page,
} from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import type { InstagramConfig } from './config.js';
import {
  getComment,
  IG_COMMENT_FIELDS,
  listComments,
  listReplies,
  toNormalizedIgComment,
} from './comments.js';

const APP_SECRET = 's'.repeat(32);
const cfg: InstagramConfig = {
  meta: {
    appId: '1234567',
    appSecret: new Secret(APP_SECRET),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  },
};

function world() {
  const graph = new FakeGraph({ appSecret: APP_SECRET, appId: cfg.meta.appId });
  const { userId } = graph.addUser();
  const { pageId, pageToken } = graph.addPage(userId, { tasks: ['MODERATE', 'MESSAGING'] });
  const { igUserId } = graph.addInstagramAccount(pageId, { username: 'brand' });
  const urls: URL[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    urls.push(new URL(String(input instanceof Request ? input.url : input)));
    return graph.fetch(input, init);
  };
  const ctx: CallContext = {
    accessToken: new Secret(pageToken),
    externalAccountId: igUserId,
    http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch }),
    signal: AbortSignal.timeout(2000),
    reportQuota: async () => undefined,
  };
  return { graph, igUserId, ctx, urls };
}
const now = Date.now;

const rawComment = (over: Record<string, unknown> = {}) => ({
  id: '17800000000000001',
  text: 'hi',
  timestamp: '2026-10-13T09:00:00+0000',
  from: { id: '17841400000000009', username: 'fan' },
  username: 'fan',
  hidden: false,
  media: { id: '17900000000000001', permalink: 'https://www.instagram.com/p/ABC/' },
  ...over,
});

describe('getComment', () => {
  it('fetches a comment with author, media, parent, timestamp and hidden state', async () => {
    const { graph, igUserId, ctx, urls } = world();
    const created = Date.parse('2026-10-13T09:00:00Z');
    const top = graph.addIgComment(igUserId, {
      text: 'top',
      authorId: '17841400000000009',
      username: 'fan',
      createdAtMs: created,
    });
    const reply = graph.addIgComment(igUserId, {
      parentId: top.commentId,
      text: 'child',
      authorId: '17841400000000010',
      username: 'other',
      createdAtMs: created,
    });
    graph.ownerHides(reply.commentId);

    const c = await getComment(cfg, now, ctx, {
      sourceExternalId: top.mediaId,
      externalId: reply.commentId,
    });
    expect(c).toEqual({
      externalId: reply.commentId,
      sourceExternalId: top.mediaId,
      parentExternalId: top.commentId,
      author: {
        externalId: '17841400000000010',
        displayName: 'other',
        profileUrl: 'https://www.instagram.com/other/',
      },
      body: 'child',
      postedAt: new Date(created),
      platformState: 'hidden',
      permalink: `https://www.instagram.com/p/${top.mediaId}/`,
    });
    const u = urls.at(-1)!;
    expect(u.pathname).toBe(`/v26.0/${reply.commentId}`);
    expect(u.searchParams.get('fields')).toBe(IG_COMMENT_FIELDS);
  });

  it('returns null for a deleted comment', async () => {
    const { graph, igUserId, ctx } = world();
    const { commentId, mediaId } = graph.addIgComment(igUserId);
    graph.ownerDeletes(commentId);
    expect(
      await getComment(cfg, now, ctx, { sourceExternalId: mediaId, externalId: commentId }),
    ).toBeNull();
  });

  it('refuses a hostile id before any network I/O', async () => {
    const { ctx, urls } = world();
    await expect(
      getComment(cfg, now, ctx, { sourceExternalId: '1', externalId: '../me/accounts' }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_graph_id' });
    expect(urls).toHaveLength(0);
  });

  it.each([
    ['emoji ZWJ', '👩‍👩‍👧‍👦 love it 🔥'],
    ['RTL', 'מוצר מעולה! شكرا'],
    ['mentions and links only', '@a @b https://x.y'],
    ['10k chars', 'א'.repeat(10_000)],
    ['markup', '<img src=x onerror=alert(1)>'],
  ])('keeps %s text intact', async (_n, text) => {
    const { graph, igUserId, ctx } = world();
    const { commentId, mediaId } = graph.addIgComment(igUserId, { text });
    const c = await getComment(cfg, now, ctx, { sourceExternalId: mediaId, externalId: commentId });
    expect(c!.body).toBe(text);
  });

  it('a permission error on read becomes auth_expired permission_revoked', async () => {
    const { graph, igUserId, ctx } = world();
    const { commentId, mediaId } = graph.addIgComment(igUserId);
    graph.failNext(10);
    const err = await getComment(cfg, now, ctx, {
      sourceExternalId: mediaId,
      externalId: commentId,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ kind: 'auth_expired', code: 'permission_revoked' });
  });
});

describe('toNormalizedIgComment', () => {
  it('replaces NUL with U+FFFD and never truncates', () => {
    const text = `a\u0000b${'x'.repeat(5000)}`;
    const c = toNormalizedIgComment(rawComment({ text }), null)!;
    expect(c.body).toBe(`a�b${'x'.repeat(5000)}`);
    expect(c.body.includes('\u0000')).toBe(false);
  });

  it('uses an empty body when text is absent', () => {
    expect(toNormalizedIgComment(rawComment({ text: undefined }), null)!.body).toBe('');
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['http:', 'http://www.instagram.com/p/x/'],
    ['other host', 'https://evil.example/p/x/'],
    ['lookalike host', 'https://www.instagram.com.evil.example/p/x/'],
    ['not a url', 'nope'],
    ['userinfo', 'https://evil@www.instagram.com/p/x/'],
    ['userinfo with password', 'https://user:pw@www.instagram.com/p/x/'],
  ])('rejects a %s permalink as null', (_n, permalink) => {
    const c = toNormalizedIgComment(
      rawComment({ media: { id: '17900000000000001', permalink } }),
      null,
    );
    expect(c).not.toBeNull();
    expect(c!.permalink).toBeNull();
  });

  it('drops a hostile username from the profile URL but keeps it as display name', () => {
    const c = toNormalizedIgComment(
      rawComment({ from: { id: '17841400000000009', username: 'a/../../x' }, username: undefined }),
      null,
    )!;
    expect(c.author).toEqual({
      externalId: '17841400000000009',
      displayName: 'a/../../x',
      profileUrl: null,
    });
  });

  it('caps the display name at 200 chars', () => {
    const c = toNormalizedIgComment(
      rawComment({ from: { id: '17841400000000009', username: 'a'.repeat(300) } }),
      null,
    )!;
    expect(c.author!.displayName).toBe('a'.repeat(200));
    expect(c.author!.profileUrl).toBeNull();
  });

  it('takes the author from user when from is absent, and username from the top level', () => {
    const c = toNormalizedIgComment(
      rawComment({ from: undefined, user: { id: '17841400000000008' }, username: 'u.s_er' }),
      null,
    )!;
    expect(c.author).toEqual({
      externalId: '17841400000000008',
      displayName: 'u.s_er',
      profileUrl: 'https://www.instagram.com/u.s_er/',
    });
  });

  it("prefers user.id over a different from.id: user is only present on the account's own comments", () => {
    const c = toNormalizedIgComment(
      rawComment({
        from: { id: '17841400000000777', username: 'shop.official' },
        user: { id: '17841400000000001' },
        username: 'shop.official',
      }),
      null,
    )!;
    expect(c.author).toEqual({
      externalId: '17841400000000001',
      displayName: 'shop.official',
      profileUrl: 'https://www.instagram.com/shop.official/',
    });
  });

  it('ignores a user.id that is not a Graph id and keeps from.id', () => {
    const c = toNormalizedIgComment(rawComment({ user: { id: '1/../2' } }), null)!;
    expect(c.author?.externalId).toBe('17841400000000009');
  });

  it('without user, the author is from.id', () => {
    const c = toNormalizedIgComment(rawComment(), null)!;
    expect(c.author).toEqual({
      externalId: '17841400000000009',
      displayName: 'fan',
      profileUrl: 'https://www.instagram.com/fan/',
    });
  });

  it('has a null author when no valid id is present', () => {
    expect(
      toNormalizedIgComment(rawComment({ from: { id: 'x/y', username: 'fan' } }), null)!.author,
    ).toBeNull();
    expect(toNormalizedIgComment(rawComment({ from: undefined }), null)!.author).toBeNull();
  });

  it('falls back to the given source id, or is unusable without one', () => {
    expect(
      toNormalizedIgComment(rawComment({ media: undefined }), '17900000000000077')!
        .sourceExternalId,
    ).toBe('17900000000000077');
    expect(
      toNormalizedIgComment(rawComment({ media: { id: '../x' } }), '17900000000000077')!
        .sourceExternalId,
    ).toBe('17900000000000077');
    expect(toNormalizedIgComment(rawComment({ media: undefined }), null)).toBeNull();
  });

  it('is null for a bad id or an invalid timestamp', () => {
    expect(toNormalizedIgComment(rawComment({ id: '../me' }), null)).toBeNull();
    expect(toNormalizedIgComment(rawComment({ timestamp: 'garbage' }), null)).toBeNull();
    expect(toNormalizedIgComment(rawComment({ timestamp: undefined }), null)).toBeNull();
    expect(toNormalizedIgComment('x', null)).toBeNull();
    expect(toNormalizedIgComment(null, null)).toBeNull();
  });

  it('keeps parent only when valid and different from the id', () => {
    expect(
      toNormalizedIgComment(rawComment({ parent_id: '17800000000000000' }), null)!.parentExternalId,
    ).toBe('17800000000000000');
    expect(
      toNormalizedIgComment(rawComment({ parent_id: '17800000000000001' }), null)!.parentExternalId,
    ).toBeNull();
    expect(
      toNormalizedIgComment(rawComment({ parent_id: '../x' }), null)!.parentExternalId,
    ).toBeNull();
  });
});

describe('listComments / listReplies', () => {
  it('lists media comments and comment replies with cursors', async () => {
    const { graph, igUserId, ctx, urls } = world();
    const first = graph.addIgComment(igUserId, { text: 'c1' });
    const second = graph.addIgComment(igUserId, { mediaId: first.mediaId, text: 'c2' });
    const third = graph.addIgComment(igUserId, { mediaId: first.mediaId, text: 'c3' });
    const r1 = graph.addIgComment(igUserId, { parentId: first.commentId, text: 'r1' });
    const r2 = graph.addIgComment(igUserId, { parentId: first.commentId, text: 'r2' });

    const p1 = await listComments(cfg, now, ctx, {
      sourceExternalId: first.mediaId,
      cursor: null,
      limit: 2,
    });
    expect(p1.items.map((c) => c.externalId)).toEqual([first.commentId, second.commentId]);
    expect(p1.items.every((c) => c.sourceExternalId === first.mediaId)).toBe(true);
    expect(p1.nextCursor).toMatch(/^[A-Za-z0-9=_-]+$/);
    const u1 = urls.at(-1)!;
    expect(u1.pathname).toBe(`/v26.0/${first.mediaId}/comments`);
    expect(u1.searchParams.get('limit')).toBe('2');
    expect(u1.searchParams.get('fields')).toBe(IG_COMMENT_FIELDS);

    const p2 = await listComments(cfg, now, ctx, {
      sourceExternalId: first.mediaId,
      cursor: p1.nextCursor,
      limit: 2,
    });
    expect(p2.items.map((c) => c.externalId)).toEqual([third.commentId]);
    expect(p2.nextCursor).toBeNull();
    expect(urls.at(-1)!.searchParams.get('after')).toBe(p1.nextCursor);

    const replies = await listReplies(cfg, now, ctx, {
      parent: { sourceExternalId: first.mediaId, externalId: first.commentId },
      cursor: null,
      limit: 100,
    });
    expect(replies.items.map((c) => c.externalId)).toEqual([r1.commentId, r2.commentId]);
    expect(replies.items.every((c) => c.parentExternalId === first.commentId)).toBe(true);
    expect(replies.nextCursor).toBeNull();
    expect(urls.at(-1)!.pathname).toBe(`/v26.0/${first.commentId}/replies`);
  });

  it('clamps limit to 1..100', async () => {
    const { graph, igUserId, ctx, urls } = world();
    const { mediaId } = graph.addIgComment(igUserId);
    await listComments(cfg, now, ctx, { sourceExternalId: mediaId, cursor: null, limit: 5000 });
    expect(urls.at(-1)!.searchParams.get('limit')).toBe('100');
    await listComments(cfg, now, ctx, { sourceExternalId: mediaId, cursor: null, limit: 0 });
    expect(urls.at(-1)!.searchParams.get('limit')).toBe('1');
  });

  it.each([
    ['full url', 'https://evil.example/next?x=1'],
    ['query injection', 'abc&access_token=x'],
    ['empty', ''],
    ['too long', 'a'.repeat(513)],
  ])(
    'rejects a %s cursor as permanent/invalid_cursor before any network I/O',
    async (_n, cursor) => {
      const { graph, igUserId, ctx, urls } = world();
      const { mediaId, commentId } = graph.addIgComment(igUserId);
      const before = urls.length;
      await expect(
        listComments(cfg, now, ctx, { sourceExternalId: mediaId, cursor, limit: 10 }),
      ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_cursor' });
      await expect(
        listReplies(cfg, now, ctx, {
          parent: { sourceExternalId: mediaId, externalId: commentId },
          cursor,
          limit: 10,
        }),
      ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_cursor' });
      expect(urls).toHaveLength(before);
    },
  );

  it('skips unusable items', async () => {
    const { graph, igUserId, ctx } = world();
    const a = graph.addIgComment(igUserId);
    // Rewrite one item so its id is hostile.
    const rewriting = createSafeHttp({
      allowedHosts: ['graph.facebook.com'],
      fetch: async (input, init) => {
        const res = await graph.fetch(input, init);
        const j = (await res.json()) as { data: Record<string, unknown>[] };
        j.data.push({ id: '../me', text: 'x', timestamp: '2026-10-13T09:00:00+0000' });
        return new Response(JSON.stringify(j), { status: 200 });
      },
    });
    const out = await listComments(
      cfg,
      now,
      { ...ctx, http: rewriting },
      {
        sourceExternalId: a.mediaId,
        cursor: null,
        limit: 10,
      },
    );
    expect(out.items.map((c) => c.externalId)).toEqual([a.commentId]);
  });

  it('a permission error while listing one media is source-level, not connection-level', async () => {
    const { graph, igUserId, ctx } = world();
    const { mediaId } = graph.addIgComment(igUserId);
    graph.failNext(10);
    await expect(
      listComments(cfg, now, ctx, { sourceExternalId: mediaId, cursor: null, limit: 25 }),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'source_inaccessible' });
  });

  it('a permission error while listing replies still marks the connection as revoked', async () => {
    const { graph, igUserId, ctx } = world();
    const { mediaId, commentId } = graph.addIgComment(igUserId);
    graph.failNext(10);
    await expect(
      listReplies(cfg, now, ctx, {
        parent: { sourceExternalId: mediaId, externalId: commentId },
        cursor: null,
        limit: 25,
      }),
    ).rejects.toMatchObject({ kind: 'auth_expired', code: 'permission_revoked' });
  });

  it('a missing media while listing is not_found source_missing', async () => {
    const { ctx } = world();
    await expect(
      listComments(cfg, now, ctx, {
        sourceExternalId: '17999999999999999',
        cursor: null,
        limit: 25,
      }),
    ).rejects.toMatchObject({ kind: 'not_found', code: 'source_missing' });
  });

  it('includeReplies returns replies inline after their parent, without per-comment calls', async () => {
    const { graph, igUserId, ctx } = world();
    const top = graph.addIgComment(igUserId, { text: 'top', createdAtMs: Date.UTC(2026, 9, 1) });
    graph.addIgComment(igUserId, { mediaId: top.mediaId, parentId: top.commentId, text: 'r1' });
    const before = graph.calls().length;
    const page = await listComments(cfg, now, ctx, {
      sourceExternalId: top.mediaId,
      cursor: null,
      limit: 25,
      includeReplies: true,
    });
    expect(page.items.map((c) => [c.body, c.parentExternalId])).toEqual([
      ['top', null],
      ['r1', top.commentId],
    ]);
    expect(graph.calls().length - before).toBe(1);
  });

  describe('inline replies', () => {
    const run = (graph: ReturnType<typeof world>['graph'], mediaId: string, ctx: CallContext) =>
      listComments(cfg, now, ctx, {
        sourceExternalId: mediaId,
        cursor: null,
        limit: 25,
        includeReplies: true,
      });

    const drain = async (
      graph: ReturnType<typeof world>['graph'],
      mediaId: string,
      ctx: CallContext,
    ) => {
      const items: NormalizedComment[] = [];
      let cursor: string | null = null;
      let calls = 0;
      do {
        const before = graph.calls().length;
        const page: Page<NormalizedComment> = await listComments(cfg, now, ctx, {
          sourceExternalId: mediaId,
          cursor,
          limit: 25,
          includeReplies: true,
        });
        expect(graph.calls().length - before).toBe(1);
        items.push(...page.items);
        cursor = page.nextCursor;
        calls++;
      } while (cursor && calls < 50);
      return { items, calls };
    };

    it('carries a parent with 120 replies across calls, one Graph request each, losing none', async () => {
      const { graph, igUserId, ctx } = world();
      const top = graph.addIgComment(igUserId, { text: 'top' });
      for (let i = 0; i < 120; i++) {
        graph.addIgComment(igUserId, {
          mediaId: top.mediaId,
          parentId: top.commentId,
          text: `r${i}`,
        });
      }
      const first = await run(graph, top.mediaId, ctx);
      expect(first.items).toHaveLength(51);
      expect(first.nextCursor).not.toBeNull();
      const { items, calls } = await drain(graph, top.mediaId, ctx);
      expect(items).toHaveLength(121);
      expect(new Set(items.map((c) => c.externalId)).size).toBe(121);
      expect(items.slice(1).every((c) => c.parentExternalId === top.commentId)).toBe(true);
      expect(calls).toBe(4);
    });

    it('stops a page before exceeding the item cap and resumes at the same comment', async () => {
      const { graph, igUserId, ctx } = world();
      const first = graph.addIgComment(igUserId, { text: 't0' });
      const tops = [first.commentId];
      for (let t = 1; t < 25; t++) {
        tops.push(
          graph.addIgComment(igUserId, { mediaId: first.mediaId, text: `t${t}` }).commentId,
        );
      }
      for (const p of tops) {
        for (let i = 0; i < 40; i++) {
          graph.addIgComment(igUserId, { mediaId: first.mediaId, parentId: p, text: `r${i}` });
        }
      }
      const page = await run(graph, first.mediaId, ctx);
      expect(page.items.length).toBeLessThanOrEqual(500);
      expect(page.nextCursor).not.toBeNull();
      const { items } = await drain(graph, first.mediaId, ctx);
      expect(items).toHaveLength(25 * 41);
      expect(new Set(items.map((c) => c.externalId)).size).toBe(25 * 41);
    });

    it("drops malformed replies, keeps a reply's own parent_id, ignores non-array replies", async () => {
      const { graph, igUserId, ctx } = world();
      const a = graph.addIgComment(igUserId, { text: 'a' });
      const b = graph.addIgComment(igUserId, { mediaId: a.mediaId, text: 'b' });
      const rewriting = createSafeHttp({
        allowedHosts: ['graph.facebook.com'],
        fetch: async (input, init) => {
          const res = await graph.fetch(input, init);
          const j = (await res.json()) as { data: Record<string, unknown>[] };
          const [x, y] = j.data;
          x!.replies = {
            data: [
              { id: '../x', text: 'bad', timestamp: '2026-10-13T09:00:00+0000' },
              {
                id: '17900000000000001',
                text: 'own',
                parent_id: '17900000000000002',
                timestamp: '2026-10-13T09:00:00+0000',
              },
            ],
          };
          y!.replies = { data: 'nope' };
          return new Response(JSON.stringify(j), { status: 200 });
        },
      });
      const page = await listComments(
        cfg,
        now,
        { ...ctx, http: rewriting },
        {
          sourceExternalId: a.mediaId,
          cursor: null,
          limit: 25,
          includeReplies: true,
        },
      );
      const byId = new Map(page.items.map((c) => [c.externalId, c]));
      expect(page.items).toHaveLength(3);
      expect(byId.get('17900000000000001')?.parentExternalId).toBe('17900000000000002');
      expect(byId.has(a.commentId) && byId.has(b.commentId)).toBe(true);
    });
  });
});
