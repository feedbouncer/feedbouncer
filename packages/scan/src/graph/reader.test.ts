import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSafeHttp, type NormalizedComment, type SafeHttp } from '@feedbouncer/connectors';
import { GRAPH_HOST } from '@feedbouncer/connector-facebook';
import { FakeGraph, testConfig } from '@feedbouncer/connector-facebook/testing';
import { Secret } from '@feedbouncer/service-runtime';
import { MAX_ADS } from '../limits.js';
import { discoverRecentAdPosts, type AdPost } from './ads.js';
import { readPostComments } from './comments.js';
import { listScanPages, resolvePage, type ScanGraph } from './pages.js';

const SECRET = 's'.repeat(32);
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const signal = new AbortController().signal;

async function userTokenFor(graph: FakeGraph, userId: string): Promise<string> {
  const verifier = 'v'.repeat(48);
  const url = new URL('https://www.facebook.com/dialog/oauth');
  url.searchParams.set('state', 'st');
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('redirect_uri', 'https://app.test/cb');
  url.searchParams.set('scope', 'pages_show_list,ads_read');
  const { code } = graph.consent(url, userId);
  const exchange = async (form: Record<string, string>) => {
    const res = await graph.fetch('https://graph.facebook.com/v26.0/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: '123456', client_secret: SECRET, ...form }).toString(),
    });
    return ((await res.json()) as { access_token: string }).access_token;
  };
  const short = await exchange({
    code,
    redirect_uri: 'https://app.test/cb',
    code_verifier: verifier,
  });
  return exchange({ grant_type: 'fb_exchange_token', fb_exchange_token: short });
}

function graphOver(http: SafeHttp, graph: FakeGraph, nowMs: () => number = () => NOW): ScanGraph {
  const fb = testConfig(graph);
  return { fb, ig: { meta: fb }, meta: { meta: fb, activeStatuses: ['ACTIVE'] }, http, nowMs };
}
const scriptedGraph = (routes: Record<string, unknown[]>) =>
  graphOver(scripted(routes), new FakeGraph({ appSecret: SECRET, appId: '123456' }));

async function world() {
  let now = NOW;
  const graph = new FakeGraph({ appSecret: SECRET, appId: '123456', clock: () => now });
  const http = createSafeHttp({ allowedHosts: [GRAPH_HOST], fetch: graph.fetch });
  const g = graphOver(http, graph, () => now);
  const { userId } = graph.addUser();
  const user = new Secret(await userTokenFor(graph, userId));
  const { pageId, pageToken } = graph.addPage(userId, { tasks: ['MODERATE'], name: 'Acme' });
  const { igUserId } = graph.addInstagramAccount(pageId, { username: 'acme' });
  const { adAccountId } = graph.addAdAccount(userId);
  const baseline = graph.calls().length;
  const darkPost = () => graph.addDarkPost(pageId).postId;
  return {
    graph,
    g,
    user,
    userId,
    pageId,
    page: new Secret(pageToken),
    igUserId,
    adAccountId,
    darkPost,
    requests: () => graph.calls().slice(baseline),
    at: (ms: number) => void (now = ms),
  };
}

const collect = async (it: AsyncIterable<NormalizedComment>) => {
  const out: NormalizedComment[] = [];
  for await (const c of it) out.push(c);
  return out;
};
const post = (postExternalId: string, platform: AdPost['platform'] = 'facebook'): AdPost => ({
  ordinal: 1,
  platform,
  postExternalId,
  adIds: ['1'],
  label: null,
  createdAt: new Date(NOW),
});

/** A SafeHttp answering from a fixed table keyed by the last path segment; unlisted paths 404. */
const scripted = (routes: Record<string, unknown[]>): SafeHttp => {
  const hits: Record<string, number> = {};
  return {
    async request(req) {
      const key = new URL(String(req.url)).pathname.split('/').pop()!;
      const i = hits[key] ?? 0;
      hits[key] = i + 1;
      const body = routes[key]?.[Math.min(i, routes[key].length - 1)];
      return { status: 200, headers: new Headers(), body: JSON.stringify(body ?? {}) };
    },
  };
};

describe('listScanPages / resolvePage', () => {
  it('marks a page without MODERATE ineligible and never returns access_token', async () => {
    const w = await world();
    const other = w.graph.addPage(w.userId, { tasks: ['MESSAGING'], name: 'Viewer' });
    const result = await listScanPages(w.g, w.user, signal);
    expect(result).toEqual([
      {
        pageId: w.pageId,
        name: 'Acme',
        igUserId: w.igUserId,
        igUsername: 'acme',
        eligible: true,
        ineligibleReason: null,
      },
      {
        pageId: other.pageId,
        name: 'Viewer',
        igUserId: null,
        igUsername: null,
        eligible: false,
        ineligibleReason: 'insufficient_page_role',
      },
    ]);
    const json = JSON.stringify(result);
    for (const secret of w.graph.issuedSecrets()) expect(json).not.toContain(secret);
  });

  it('resolves the page token, moderation right and linked instagram account', async () => {
    const w = await world();
    const viewer = w.graph.addPage(w.userId, { tasks: ['MESSAGING'] });
    const r = await resolvePage(w.g, w.user, w.pageId, signal);
    expect(r.pageToken.reveal()).toBe(w.page.reveal());
    expect(r).toMatchObject({ canModerate: true, igUserId: w.igUserId });
    expect(await resolvePage(w.g, w.user, viewer.pageId, signal)).toMatchObject({
      canModerate: false,
      igUserId: null,
    });
  });

  it('rejects a page id that is not a Graph id before any request', async () => {
    const w = await world();
    await expect(resolvePage(w.g, w.user, '../me', signal)).rejects.toMatchObject({
      code: 'invalid_graph_id',
    });
    expect(w.requests()).toEqual([]);
  });
});

describe('discoverRecentAdPosts', () => {
  it("keeps only this page's posts, groups ads sharing one story and drops stale paused ads", async () => {
    const w = await world();
    const other = w.graph.addPage(w.userId, { tasks: ['MODERATE'] });
    const shared = w.darkPost();
    const solo = w.darkPost();
    w.at(NOW - 3 * DAY);
    w.graph.addAd(w.adAccountId, { storyId: shared, name: 'first' });
    w.at(NOW - 2 * DAY);
    w.graph.addAd(w.adAccountId, { storyId: shared, name: 'second' });
    w.at(NOW - 1 * DAY);
    const newest = w.graph.addAd(w.adAccountId, { storyId: shared, name: 'newest' });
    w.at(NOW - 5 * DAY);
    w.graph.addAd(w.adAccountId, { storyId: solo, name: 'solo' });
    w.graph.addAd(w.adAccountId, { storyId: w.graph.addDarkPost(other.pageId).postId });
    w.at(NOW - 40 * DAY);
    const stale = w.graph.addAd(w.adAccountId, { storyId: w.darkPost() });
    w.graph.setAdStatus(stale.adId, 'PAUSED');
    w.at(NOW - 10 * DAY);
    const recent = w.graph.addAd(w.adAccountId, { storyId: w.darkPost(), name: 'paused' });
    w.graph.setAdStatus(recent.adId, 'PAUSED');
    w.at(NOW);

    const posts = await discoverRecentAdPosts(
      w.g,
      w.user,
      { pageId: w.pageId, igUserId: null },
      signal,
    );
    expect(posts.map((p) => [p.ordinal, p.platform, p.postExternalId, p.label])).toEqual([
      [1, 'facebook', shared, 'newest'],
      [2, 'facebook', solo, 'solo'],
      [3, 'facebook', expect.any(String), 'paused'],
    ]);
    expect(posts[0]!.adIds).toHaveLength(3);
    expect(posts[0]!.adIds).toContain(newest.adId);
    expect(posts[0]!.createdAt).toEqual(new Date(NOW - 1 * DAY));
    expect(posts.flatMap((p) => p.adIds)).not.toContain(stale.adId);
  });

  it('caps at the 25 newest ads across cursor pages and numbers them from 1', async () => {
    const w = await world();
    for (let i = 0; i < 130; i++) {
      w.at(NOW - (130 - i) * 60_000);
      w.graph.addAd(w.adAccountId, { storyId: w.darkPost(), name: `ad ${i}` });
    }
    w.at(NOW);
    const posts = await discoverRecentAdPosts(
      w.g,
      w.user,
      { pageId: w.pageId, igUserId: null },
      signal,
    );
    expect(posts).toHaveLength(MAX_ADS);
    expect(posts.map((p) => p.ordinal)).toEqual(Array.from({ length: MAX_ADS }, (_, i) => i + 1));
    expect(posts[0]!.label).toBe('ad 129');
    expect(posts.at(-1)!.label).toBe('ad 105');
  });

  it('includes the instagram placement only when igUserId matches', async () => {
    const w = await world();
    const story = w.darkPost();
    w.graph.addAd(w.adAccountId, {
      storyId: story,
      igMediaId: '17900000000000001',
      igUserId: w.igUserId,
    });
    const run = (igUserId: string | null) =>
      discoverRecentAdPosts(w.g, w.user, { pageId: w.pageId, igUserId }, signal);

    expect((await run(w.igUserId)).map((p) => [p.platform, p.postExternalId]).sort()).toEqual([
      ['facebook', story],
      ['instagram', '17900000000000001'],
    ]);
    expect((await run(null)).map((p) => p.platform)).toEqual(['facebook']);
    expect((await run('17841400000000999')).map((p) => p.platform)).toEqual(['facebook']);
  });

  it('maps a lost ad permission to auth_expired', async () => {
    const w = await world();
    w.graph.revokeAdAccountAccess(w.userId, w.adAccountId);
    await expect(
      discoverRecentAdPosts(w.g, w.user, { pageId: w.pageId, igUserId: null }, signal),
    ).rejects.toMatchObject({ kind: 'auth_expired', code: 'ads_permission_missing' });
  });
});

describe('readPostComments', () => {
  async function commented(count: number) {
    const w = await world();
    const { postId } = w.graph.addPost(w.pageId);
    for (let i = 0; i < count; i++) {
      w.graph.addComment(w.pageId, {
        postId,
        message: `c${i}`,
        createdAtMs: NOW - (count - i) * 1000,
      });
    }
    return { ...w, postId };
  }

  it('yields newest first and stops at sinceMs', async () => {
    const w = await commented(5);
    const out = await collect(
      readPostComments(w.g, w.page, post(w.postId), NOW - 3500, 400, signal),
    );
    expect(out.map((c) => c.body)).toEqual(['c4', 'c3', 'c2']);
  });

  it('stops at perPostCap and counts hidden comments toward it', async () => {
    const w = await commented(5);
    const [, , third] = (
      await collect(readPostComments(w.g, w.page, post(w.postId), 0, 400, signal))
    ).map((c) => c.externalId);
    w.graph.hideComment(third!);
    const out = await collect(readPostComments(w.g, w.page, post(w.postId), 0, 3, signal));
    expect(out.map((c) => c.body)).toEqual(['c4', 'c3', 'c2']);
    expect(out.map((c) => c.platformState)).toEqual(['visible', 'visible', 'hidden']);
  });

  it('yields a comment repeated across pages once', async () => {
    const comment = (n: number) => ({
      id: `100_1_${n}`,
      message: `c${n}`,
      created_time: new Date(NOW - n * 1000).toISOString(),
    });
    const g = scriptedGraph({
      comments: [
        { data: [comment(1), comment(2)], paging: { cursors: { after: 'x1' }, next: 'https://n' } },
        { data: [comment(2), comment(3)] },
      ],
    });
    const out = await collect(readPostComments(g, new Secret('t'), post('100_1'), 0, 400, signal));
    expect(out.map((c) => c.externalId)).toEqual(['100_1_1', '100_1_2', '100_1_3']);
  });

  it('reads instagram comments with their replies', async () => {
    const w = await world();
    const top = w.graph.addIgComment(w.igUserId, { text: 'nice' });
    w.graph.addIgComment(w.igUserId, {
      mediaId: top.mediaId,
      parentId: top.commentId,
      text: 'thx',
    });
    const out = await collect(
      readPostComments(w.g, w.page, post(top.mediaId, 'instagram'), 0, 400, signal),
    );
    expect(out.map((c) => c.body)).toEqual(['nice', 'thx']);
    expect(out[1]!.parentExternalId).toBe(top.commentId);
  });

  it('rejects instagram posts when instagram is not configured', async () => {
    const w = await world();
    w.g.ig = null;
    await expect(
      collect(readPostComments(w.g, w.page, post('17900000000000001', 'instagram'), 0, 5, signal)),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('surfaces Graph 190 as auth_expired and 613 as rate_limited with retryAfterMs', async () => {
    const w = await commented(1);
    w.graph.failNext(190);
    await expect(
      collect(readPostComments(w.g, w.page, post(w.postId), 0, 5, signal)),
    ).rejects.toMatchObject({ kind: 'auth_expired' });
    w.graph.throttleNext(613, 2);
    await expect(
      collect(readPostComments(w.g, w.page, post(w.postId), 0, 5, signal)),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
  });

  it('rejects a post id that is not a Graph id before any request', async () => {
    const w = await world();
    await expect(
      collect(readPostComments(w.g, w.page, post('../me'), 0, 5, signal)),
    ).rejects.toMatchObject({ code: 'invalid_graph_id' });
    expect(w.requests()).toEqual([]);
  });
});

describe('malformed Graph pages', () => {
  const invalid = { kind: 'permanent', code: 'invalid_graph_response' };

  it('are ConnectorError invalid_graph_response, not a crash', async () => {
    const g = scriptedGraph({
      accounts: [{ data: 'nope' }],
      adaccounts: [{ data: [] }],
      comments: [{ data: 7 }],
    });
    await expect(listScanPages(g, new Secret('t'), signal)).rejects.toMatchObject(invalid);
    await expect(
      collect(readPostComments(g, new Secret('t'), post('100_1'), 0, 5, signal)),
    ).rejects.toMatchObject(invalid);
    await expect(resolvePage(g, new Secret('t'), '100', signal)).rejects.toMatchObject(invalid);

    const ads = scriptedGraph({
      adaccounts: [{ data: [{ id: 'act_1', account_id: '1', account_status: 1 }] }],
      ads: [{ data: 'nope' }],
    });
    await expect(
      discoverRecentAdPosts(ads, new Secret('t'), { pageId: '100', igUserId: null }, signal),
    ).rejects.toMatchObject(invalid);
  });
});

describe('read-only guarantee', () => {
  it('every Graph request made by the readers is GET', async () => {
    const w = await world();
    w.graph.addAd(w.adAccountId, { storyId: w.darkPost(), igMediaId: '179', igUserId: w.igUserId });
    const { postId } = w.graph.addPost(w.pageId);
    w.graph.addComment(w.pageId, { postId });
    const ig = w.graph.addIgComment(w.igUserId, {});

    await listScanPages(w.g, w.user, signal);
    await resolvePage(w.g, w.user, w.pageId, signal);
    await discoverRecentAdPosts(w.g, w.user, { pageId: w.pageId, igUserId: w.igUserId }, signal);
    await collect(readPostComments(w.g, w.page, post(postId), 0, 5, signal));
    await collect(readPostComments(w.g, w.page, post(ig.mediaId, 'instagram'), 0, 5, signal));

    const calls = w.requests();
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});
