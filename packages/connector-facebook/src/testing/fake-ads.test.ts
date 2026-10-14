import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeGraph, pageCall } from './index.js';
import { graphRequest } from '../graph.js';

const SECRET = 's'.repeat(32);

interface Listing {
  data: { message?: string; text?: string; replies?: { data: { text: string }[] } }[];
  paging?: { next?: string; cursors: { after: string } };
}

async function world() {
  const graph = new FakeGraph({ appSecret: SECRET, appId: '123456' });
  const { userId } = graph.addUser();
  const userToken = await userTokenFor(graph, userId);
  const { pageId, pageToken } = graph.addPage(userId, { tasks: ['MODERATE'] });
  const { adAccountId } = graph.addAdAccount(userId, { name: 'Acme ads' });
  return { graph, userId, userToken, pageId, pageToken, adAccountId };
}

describe('FakeGraph ads', () => {
  it('lists ad accounts with act_ ids', async () => {
    const { graph, userToken, adAccountId } = await world();
    const { body } = await graphRequest(pageCall(graph, userToken), {
      method: 'GET',
      path: ['me', 'adaccounts'],
      query: { fields: 'id,account_id,name,account_status' },
    });
    expect(body).toMatchObject({
      data: [{ id: `act_${adAccountId}`, account_id: adAccountId, account_status: 1 }],
    });
  });

  it('filters ads by effective_status and pages with an off-host next url', async () => {
    const { graph, userToken, adAccountId, pageId } = await world();
    for (let i = 0; i < 3; i++)
      graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    graph.addAd(adAccountId, { status: 'PAUSED' });
    const call = pageCall(graph, userToken);
    const q = { fields: 'id,effective_status', effective_status: '["ACTIVE"]', limit: '2' };
    const first = (
      await graphRequest(call, { method: 'GET', path: [`act_${adAccountId}`, 'ads'], query: q })
    ).body as Listing;
    expect(first.data).toHaveLength(2);
    expect(first.paging!.next).toMatch(/^https:\/\/evil\.example\//);
    const second = (
      await graphRequest(call, {
        method: 'GET',
        path: [`act_${adAccountId}`, 'ads'],
        query: { ...q, after: first.paging!.cursors.after },
      })
    ).body as Listing;
    expect(second.data).toHaveLength(1);
    expect(second.paging?.next).toBeUndefined();
  });

  it('shapes ads and creatives, and setters mutate them', async () => {
    const { graph, userToken, adAccountId } = await world();
    const { adId, creativeId } = graph.addAd(adAccountId, {
      storyId: '1_2',
      igMediaId: '3',
      igUserId: '4',
    });
    graph.setAdCreative(adId, { storyId: null });
    graph.setAdStatus(adId, 'PAUSED');
    const { body } = await graphRequest(pageCall(graph, userToken), {
      method: 'GET',
      path: [`act_${adAccountId}`, 'ads'],
    });
    const ad = (body as { data: { creative: unknown }[] }).data[0];
    expect(ad).toMatchObject({ id: adId, account_id: adAccountId, effective_status: 'PAUSED' });
    expect(ad!.creative).toEqual({
      id: creativeId,
      effective_instagram_media_id: '3',
      instagram_user_id: '4',
      object_type: 'SHARE',
    });
  });

  it('rejects malformed effective_status JSON with 100', async () => {
    const { graph, userToken, adAccountId } = await world();
    await expect(
      graphRequest(pageCall(graph, userToken), {
        method: 'GET',
        path: [`act_${adAccountId}`, 'ads'],
        query: { effective_status: '[ACTIVE' },
      }),
    ).rejects.toBeDefined();
  });

  it('serves dark-post comments with paging to the page token', async () => {
    const { graph, pageId, pageToken } = await world();
    const { postId } = graph.addDarkPost(pageId);
    for (let i = 0; i < 5; i++)
      graph.addComment(pageId, {
        postId,
        message: `c${i}`,
        createdAtMs: Date.UTC(2026, 9, 1, 0, i),
      });
    const call = pageCall(graph, pageToken);
    const q = { limit: '2', filter: 'stream', order: 'reverse_chronological' };
    const p1 = (await graphRequest(call, { method: 'GET', path: [postId, 'comments'], query: q }))
      .body as Listing;
    expect(p1.data.map((c) => c.message)).toEqual(['c4', 'c3']);
    expect(p1.paging!.cursors.after).toBeTruthy();
    const p2 = (
      await graphRequest(call, {
        method: 'GET',
        path: [postId, 'comments'],
        query: { ...q, after: p1.paging!.cursors.after },
      })
    ).body as Listing;
    expect(p2.data.map((c) => c.message)).toEqual(['c2', 'c1']);
  });

  it('a removed post answers 100/33', async () => {
    const { graph, pageId, pageToken } = await world();
    const { postId } = graph.addDarkPost(pageId);
    graph.removePost(postId);
    await expect(
      graphRequest(pageCall(graph, pageToken), { method: 'GET', path: [postId, 'comments'] }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('revoked ad account access returns the configured permission error', async () => {
    const { graph, userId, userToken, adAccountId } = await world();
    graph.revokeAdAccountAccess(userId, adAccountId);
    await expect(
      graphRequest(pageCall(graph, userToken), {
        method: 'GET',
        path: [`act_${adAccountId}`, 'ads'],
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('emits X-Ad-Account-Usage when configured', async () => {
    const { graph, userToken, adAccountId } = await world();
    graph.setAdAccountUsage(adAccountId, 95, 60);
    const r = await graphRequest(pageCall(graph, userToken), {
      method: 'GET',
      path: [`act_${adAccountId}`, 'ads'],
    });
    expect(r.adAccountUsage).toEqual({ utilPct: 95, resetMs: 60_000 });
  });

  it('inlines first-level replies on instagram media comments when fields asks for them', async () => {
    const { graph, pageId, pageToken } = await world();
    const { igUserId } = graph.addInstagramAccount(pageId, { username: 'brand' });
    const top = graph.addIgComment(igUserId, { text: 'top' });
    graph.addIgComment(igUserId, { mediaId: top.mediaId, parentId: top.commentId, text: 'child' });
    const call = pageCall(graph, pageToken);
    const get = async (fields: string) =>
      (
        await graphRequest(call, {
          method: 'GET',
          path: [top.mediaId, 'comments'],
          query: { fields },
        })
      ).body as Listing;
    const withReplies = await get('id,text,replies.limit(50){id,text}');
    expect(withReplies.data[0]?.replies?.data.map((r) => r.text)).toEqual(['child']);
    expect((await get('id,text')).data[0]?.replies).toBeUndefined();
  });
});

async function userTokenFor(graph: FakeGraph, userId: string): Promise<string> {
  // Consent + code exchange + long-lived exchange, the same path the OAuth flow takes.
  const verifier = 'v'.repeat(48);
  const url = new URL('https://www.facebook.com/dialog/oauth');
  url.searchParams.set('state', 'st');
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('redirect_uri', 'https://app.test/cb');
  url.searchParams.set(
    'scope',
    'pages_show_list,instagram_basic,instagram_manage_comments,instagram_manage_messages',
  );
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
