import { describe, expect, it } from 'vitest';
import { FakeGraph } from './testing/fake-graph.js';
import { ctxFor, testConfig } from './testing/calls.js';
import { listRecentPosts, recentCursor } from './sources.js';

const DAY = 86_400_000;

describe('listRecentPosts', () => {
  const setup = () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const g = new FakeGraph({ appSecret: 's', appId: '1', clock: () => now });
    const { userId } = g.addUser();
    const { pageId, pageToken } = g.addPage(userId);
    return { now, g, pageId, ctx: ctxFor(g, pageToken, pageId), cfg: testConfig(g) };
  };
  const win = (now: number, days = 30) => new Date(now - days * DAY);

  it('returns in-window posts newest first and stops at since', async () => {
    const { now, g, pageId, ctx, cfg } = setup();
    const inWin = [5, 3, 1].map((d) => g.addPost(pageId, { createdAtMs: now - d * DAY }).postId);
    g.addPost(pageId, { createdAtMs: now - 45 * DAY });
    const page = await listRecentPosts(cfg, () => now, ctx, {
      since: win(now),
      cursor: null,
      limit: 100,
    });
    expect(page.items.map((s) => s.externalId)).toEqual([...inWin].reverse());
    expect(page.nextCursor).toBeNull();
  });

  it('pinned old post does not end the listing', async () => {
    const { now, g, pageId, ctx, cfg } = setup();
    g.addPost(pageId, { createdAtMs: now - 90 * DAY, pinned: true });
    const recent = g.addPost(pageId, { createdAtMs: now - DAY }).postId;
    const older = g.addPost(pageId, { createdAtMs: now - 2 * DAY }).postId;
    let cursor: string | null = null;
    const seen: string[] = [];
    do {
      const p = await listRecentPosts(cfg, () => now, ctx, { since: win(now), cursor, limit: 1 });
      seen.push(...p.items.map((s) => s.externalId));
      cursor = p.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([recent, older]);
  });

  it('drops posts with unsafe ids or bad times without failing the page', async () => {
    const { now, g, pageId, ctx, cfg } = setup();
    const ok = g.addPost(pageId, { createdAtMs: now - DAY }).postId;
    g.injectFeedItem(pageId, { id: '../../me', created_time: '2026-10-13T00:00:00+0000' });
    g.injectFeedItem(pageId, { id: '1_2', created_time: 'not-a-time' });
    const page = await listRecentPosts(cfg, () => now, ctx, {
      since: win(now),
      cursor: null,
      limit: 100,
    });
    expect(page.items.map((s) => s.externalId)).toEqual([ok]);
  });

  it('maps throttling and auth errors through graph.ts', async () => {
    const { now, g, pageId, ctx, cfg } = setup();
    g.throttleNext(80001, 2);
    await expect(
      listRecentPosts(cfg, () => now, ctx, { since: win(now, 1), cursor: null, limit: 10 }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
    g.revokePageToken(pageId);
    await expect(
      listRecentPosts(cfg, () => now, ctx, { since: win(now, 1), cursor: null, limit: 10 }),
    ).rejects.toMatchObject({ kind: 'auth_expired' });
  });

  it('never sends the token in the URL and never follows paging.next', async () => {
    const { now, g, pageId, ctx, cfg } = setup();
    for (let i = 0; i < 3; i++) g.addPost(pageId, { createdAtMs: now - (i + 1) * 3_600_000 });
    let cursor: string | null = null;
    do {
      cursor = (
        await listRecentPosts(cfg, () => now, ctx, { since: win(now, 1), cursor, limit: 1 })
      ).nextCursor;
    } while (cursor);
    const calls = g.calls();
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.path).not.toMatch(/access_token=/);
      expect(c.path).toBe(`${pageId}/feed`);
    }
  });

  it('cursor codec round-trips and rejects garbage', () => {
    expect(recentCursor.decode(recentCursor.encode({ after: 'QVFI-_x' }))).toEqual({
      after: 'QVFI-_x',
      until: null,
    });
    expect(recentCursor.decode(recentCursor.encode({ until: '1760400000' }))).toEqual({
      after: null,
      until: '1760400000',
    });
    expect(() => recentCursor.decode('u:12; DROP')).toThrow(/invalid_cursor/);
    expect(() => recentCursor.decode('z:abc')).toThrow(/invalid_cursor/);
  });
});
