import { describe, expect, it } from 'vitest';
import { FakeGraph } from './fake-graph.js';

type Listing = {
  data: { id: string; created_time?: string; timestamp?: string }[];
  paging?: { cursors?: { after?: string }; next?: string };
  error?: { code: number };
};
const get = async (g: FakeGraph, path: string, token: string): Promise<Listing> => {
  const url = new URL(`https://graph.facebook.com/v26.0/${path}`);
  url.searchParams.set(
    'appsecret_proof',
    (await import('node:crypto'))
      .createHmac('sha256', g.appSecretValue())
      .update(token)
      .digest('hex'),
  );
  const res = await g.fetch(url, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()) as Listing;
};

describe('FakeGraph feed and media', () => {
  it('lists Page posts pinned first then newest first, filtered by since, paged by after', async () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const g = new FakeGraph({ appSecret: 's', appId: '1', clock: () => now });
    const { userId } = g.addUser();
    const { pageId, pageToken } = g.addPage(userId);
    const old = g.addPost(pageId, { createdAtMs: now - 40 * 86_400_000, pinned: true });
    const a = g.addPost(pageId, { createdAtMs: now - 2 * 86_400_000 });
    const b = g.addPost(pageId, { createdAtMs: now - 1 * 86_400_000 });
    const p1 = await get(
      g,
      `${pageId}/feed?fields=id,created_time,permalink_url&limit=2`,
      pageToken,
    );
    expect(p1.data.map((p) => p.id)).toEqual([old.postId, b.postId]);
    const p2 = await get(
      g,
      `${pageId}/feed?fields=id,created_time&limit=2&after=${p1.paging!.cursors!.after}`,
      pageToken,
    );
    expect(p2.data.map((p) => p.id)).toEqual([a.postId]);
    expect(p2.paging?.next).toBeUndefined();
    const since = Math.floor((now - 30 * 86_400_000) / 1000);
    const f = await get(g, `${pageId}/feed?fields=id&since=${since}`, pageToken);
    expect(f.data.map((p) => p.id)).toEqual([b.postId, a.postId]);
  });

  it('lists IG media newest first, reports FB hidden comments, and fails by path', async () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const g = new FakeGraph({ appSecret: 's', appId: '1', clock: () => now });
    const { userId } = g.addUser();
    const { pageId, pageToken } = g.addPage(userId);
    const { igUserId } = g.addInstagramAccount(pageId);
    const m1 = g.addIgMedia(igUserId, { createdAtMs: now - 3_000 });
    const m2 = g.addIgMedia(igUserId, { createdAtMs: now - 1_000 });
    const r = await get(g, `${igUserId}/media?fields=id,timestamp`, pageToken);
    expect(r.data.map((m) => m.id)).toEqual([m2.mediaId, m1.mediaId]);
    const { commentId } = g.addComment(pageId);
    g.hideComment(commentId);
    expect(g.state(commentId)).toBe('hidden');
    g.failNextFor('/media', 200);
    expect((await get(g, `${pageId}/feed?fields=id`, pageToken)).error).toBeUndefined();
    expect((await get(g, `${igUserId}/media?fields=id`, pageToken)).error?.code).toBe(200);
  });
});
