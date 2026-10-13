import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeGraph, pageCall, FAKE_IG_ERRORS } from './index.js';
import { graphErrorCodes, graphRequest, GRAPH_ID } from '../graph.js';

const SECRET = 's'.repeat(32);
function world() {
  const graph = new FakeGraph({ appSecret: SECRET, appId: '123456' });
  const { userId } = graph.addUser();
  const { pageId, pageToken } = graph.addPage(userId, { tasks: ['MODERATE', 'MESSAGING'] });
  const { igUserId } = graph.addInstagramAccount(pageId, { username: 'brand' });
  return { graph, userId, pageId, pageToken, igUserId, call: pageCall(graph, pageToken) };
}
const codes = (e: unknown) => graphErrorCodes(e as never);

describe('FakeGraph instagram', () => {
  it('signs instagram deliveries with the app secret', () => {
    const { graph, igUserId } = world();
    const { headers, rawBody } = graph.signedInstagramDelivery(igUserId, [
      { commentId: '17800000000000001', mediaId: '17900000000000001', text: 'hi' },
    ]);
    expect(headers['x-hub-signature-256']).toBe(
      `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
    );
    expect(JSON.parse(rawBody.toString()).object).toBe('instagram');
  });

  it('builds comment change entries with the requested time unit', () => {
    const { graph, igUserId } = world();
    const c = {
      commentId: '17800000000000001',
      mediaId: '17900000000000001',
      parentId: '17800000000000002',
      text: 'hi',
      authorId: '17800000000000009',
      username: 'u',
      productType: 'REELS',
    };
    const sec = JSON.parse(graph.signedInstagramDelivery(igUserId, [c]).rawBody.toString());
    const ms = JSON.parse(
      graph.signedInstagramDelivery(igUserId, [c], { timeUnit: 'ms' }).rawBody.toString(),
    );
    expect(sec.entry[0].id).toBe(igUserId);
    expect(sec.entry[0].changes[0].field).toBe('comments');
    expect(sec.entry[0].changes[0].value).toMatchObject({
      comment_id: c.commentId,
      parent_id: c.parentId,
      text: 'hi',
      from: { id: c.authorId, username: 'u' },
      media: { id: c.mediaId, media_product_type: 'REELS' },
    });
    expect(ms.entry[0].time).toBeGreaterThan(sec.entry[0].time * 100);
  });

  it('issues ids that pass GRAPH_ID', () => {
    const { graph, igUserId } = world();
    const { commentId, mediaId } = graph.addIgComment(igUserId);
    expect(igUserId).toMatch(/^178\d{14}$/);
    expect(commentId).toMatch(/^178\d{14}$/);
    expect(mediaId).toMatch(/^179\d{14}$/);
    for (const id of [igUserId, commentId, mediaId]) expect(GRAPH_ID.test(id)).toBe(true);
  });

  it('lists Pages with their linked instagram account only', async () => {
    const { graph, userId, igUserId, pageId } = world();
    const { pageId: plain } = graph.addPage(userId);
    const userToken = await userTokenFor(graph, userId);
    const res = await graphRequest(pageCall(graph, userToken), {
      method: 'GET',
      path: ['me', 'accounts'],
      query: { fields: 'id,name,access_token,instagram_business_account{id,username}' },
    });
    const data = (res.body as { data: { id: string; instagram_business_account?: unknown }[] })
      .data;
    expect(data.find((p) => p.id === pageId)?.instagram_business_account).toEqual({
      id: igUserId,
      username: 'brand',
    });
    expect(data.find((p) => p.id === plain)?.instagram_business_account).toBeUndefined();
  });

  it('reports granted permissions, defaulting to all instagram scopes', async () => {
    const { graph, userId } = world();
    const call = pageCall(graph, await userTokenFor(graph, userId));
    const read = async () =>
      (
        (await graphRequest(call, { method: 'GET', path: ['me', 'permissions'] })).body as {
          data: { permission: string; status: string }[];
        }
      ).data;
    expect((await read()).filter((p) => p.status === 'granted').map((p) => p.permission)).toEqual(
      expect.arrayContaining([
        'instagram_basic',
        'instagram_manage_comments',
        'instagram_manage_messages',
      ]),
    );
    graph.setGrantedPermissions(userId, ['instagram_basic']);
    expect(await read()).toEqual([{ permission: 'instagram_basic', status: 'granted' }]);
  });

  it('reads a comment', async () => {
    const { graph, igUserId, call } = world();
    const { commentId, mediaId } = graph.addIgComment(igUserId, { text: 'nice', username: 'fan' });
    const res = await graphRequest(call, {
      method: 'GET',
      path: [commentId],
      query: { fields: 'id,text' },
    });
    expect(res.body).toMatchObject({
      id: commentId,
      text: 'nice',
      username: 'fan',
      hidden: false,
      from: { username: 'fan' },
      media: { id: mediaId, permalink: `https://www.instagram.com/p/${mediaId}/` },
    });
  });

  it('hides, unhides and deletes; deleted comments return 100/33', async () => {
    const { graph, igUserId, call } = world();
    const { commentId } = graph.addIgComment(igUserId, { text: 'x' });
    await graphRequest(call, { method: 'POST', path: [commentId], form: { hide: 'true' } });
    expect(graph.igState(commentId)).toBe('hidden');
    await graphRequest(call, { method: 'POST', path: [commentId], form: { hide: 'false' } });
    expect(graph.igState(commentId)).toBe('visible');
    await graphRequest(call, { method: 'DELETE', path: [commentId] });
    expect(graph.igState(commentId)).toBe('deleted');
    await expect(
      graphRequest(call, { method: 'GET', path: [commentId], query: { fields: 'id' } }),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(graphRequest(call, { method: 'DELETE', path: [commentId] })).rejects.toSatisfy(
      (e) => codes(e)?.code === 100 && codes(e)?.subcode === 33,
    );
    await expect(
      graphRequest(call, { method: 'POST', path: [commentId], form: { hide: 'true' } }),
    ).rejects.toSatisfy((e) => codes(e)?.code === 100 && codes(e)?.subcode === 33);
  });

  it('owner actions in the app change state without a graph call', async () => {
    const { graph, igUserId } = world();
    const a = graph.addIgComment(igUserId);
    const b = graph.addIgComment(igUserId);
    const before = graph.calls().length;
    graph.ownerHides(a.commentId);
    graph.ownerDeletes(b.commentId);
    expect(graph.igState(a.commentId)).toBe('hidden');
    expect(graph.igState(b.commentId)).toBe('deleted');
    expect(graph.calls()).toHaveLength(before);
  });

  it('own-account comments stay visible after hide', async () => {
    const { graph, igUserId, call } = world();
    const { commentId } = graph.addIgComment(igUserId, { authorId: igUserId });
    const res = await graphRequest(call, {
      method: 'POST',
      path: [commentId],
      form: { hide: 'true' },
    });
    expect(res.body).toEqual({ success: true });
    expect(graph.igState(commentId)).toBe('visible');
  });

  it('refuses replies to hidden comments', async () => {
    const { graph, igUserId, call } = world();
    const { commentId } = graph.addIgComment(igUserId);
    graph.ownerHides(commentId);
    await expect(
      graphRequest(call, { method: 'POST', path: [commentId, 'replies'], form: { message: 'hi' } }),
    ).rejects.toSatisfy((e) => {
      const c = codes(e);
      return (
        c?.code === FAKE_IG_ERRORS.replyToHidden.code &&
        c?.subcode === FAKE_IG_ERRORS.replyToHidden.subcode
      );
    });
  });

  it('attaches a reply to a nested reply onto the top-level comment', async () => {
    const { graph, igUserId, call } = world();
    const top = graph.addIgComment(igUserId);
    const nested = graph.addIgComment(igUserId, { mediaId: top.mediaId, parentId: top.commentId });
    const res = await graphRequest(call, {
      method: 'POST',
      path: [nested.commentId, 'replies'],
      form: { message: 'thanks' },
    });
    expect((res.body as { id: string }).id).toMatch(/^178\d{14}$/);
    expect(graph.igReplies(top.commentId).map((r) => r.text)).toContain('thanks');
    expect(graph.igReplies(top.commentId).find((r) => r.text === 'thanks')?.fromId).toBe(igUserId);
  });

  it('paginates comments and replies by cursor', async () => {
    const { graph, igUserId, call } = world();
    const first = graph.addIgComment(igUserId, { text: 'c1' });
    graph.addIgComment(igUserId, { mediaId: first.mediaId, text: 'c2' });
    graph.addIgComment(igUserId, { mediaId: first.mediaId, text: 'c3' });
    const page = async (after?: string) =>
      (
        await graphRequest(call, {
          method: 'GET',
          path: [first.mediaId, 'comments'],
          query: { fields: 'id,text', limit: '2', ...(after ? { after } : {}) },
        })
      ).body as {
        data: { text: string }[];
        paging?: { cursors?: { after?: string }; next?: string };
      };
    const p1 = await page();
    expect(p1.data.map((c) => c.text)).toEqual(['c1', 'c2']);
    expect(p1.paging?.next).toBeDefined();
    const p2 = await page(p1.paging?.cursors?.after);
    expect(p2.data.map((c) => c.text)).toEqual(['c3']);
    expect(p2.paging?.next).toBeUndefined();

    const r1 = graph.addIgComment(igUserId, {
      mediaId: first.mediaId,
      parentId: first.commentId,
      text: 'r1',
    });
    graph.addIgComment(igUserId, { mediaId: first.mediaId, parentId: first.commentId, text: 'r2' });
    const reps = (
      await graphRequest(call, {
        method: 'GET',
        path: [first.commentId, 'replies'],
        query: { limit: '1' },
      })
    ).body as { data: { id: string }[]; paging?: { next?: string } };
    expect(reps.data.map((c) => c.id)).toEqual([r1.commentId]);
    expect(reps.paging?.next).toBeDefined();
  });

  it('private reply: once, within 7 days, top-level only, needs messaging permission', async () => {
    const { graph, igUserId, userId, call } = world();
    const send = (commentId: string) =>
      graphRequest(call, {
        method: 'POST',
        path: [igUserId, 'messages'],
        json: { recipient: { comment_id: commentId }, message: { text: 'hi' } },
      });
    const fresh = graph.addIgComment(igUserId);
    const ok = await send(fresh.commentId);
    expect(ok.body).toMatchObject({
      recipient_id: expect.any(String),
      message_id: expect.any(String),
    });
    expect(graph.igPrivateReplies(fresh.commentId)).toHaveLength(1);
    await expect(send(fresh.commentId)).rejects.toSatisfy((e) => {
      const c = codes(e);
      return (
        c?.code === FAKE_IG_ERRORS.privateReplyAlreadySent.code &&
        c?.subcode === FAKE_IG_ERRORS.privateReplyAlreadySent.subcode
      );
    });
    const old = graph.addIgComment(igUserId, { createdAtMs: Date.now() - 7 * 86_400_000 });
    await expect(send(old.commentId)).rejects.toSatisfy((e) => {
      const c = codes(e);
      return (
        c?.code === FAKE_IG_ERRORS.privateReplyWindowClosed.code &&
        c?.subcode === FAKE_IG_ERRORS.privateReplyWindowClosed.subcode
      );
    });
    const nested = graph.addIgComment(igUserId, {
      parentId: fresh.commentId,
      mediaId: fresh.mediaId,
    });
    await expect(send(nested.commentId)).rejects.toSatisfy((e) => {
      const c = codes(e);
      return (
        c?.code === FAKE_IG_ERRORS.privateReplyNested.code &&
        c?.subcode === FAKE_IG_ERRORS.privateReplyNested.subcode
      );
    });
    graph.setGrantedPermissions(userId, ['instagram_basic', 'instagram_manage_comments']);
    const other = graph.addIgComment(igUserId);
    await expect(send(other.commentId)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(send(other.commentId)).rejects.toSatisfy((e) => codes(e)?.code === 10);
  });

  it('requires the linked Page token and the appsecret_proof', async () => {
    const { graph, userId, igUserId } = world();
    const { commentId } = graph.addIgComment(igUserId);
    const { pageToken: otherToken } = graph.addPage(userId);
    await expect(
      graphRequest(pageCall(graph, otherToken), {
        method: 'POST',
        path: [commentId],
        form: { hide: 'true' },
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(graph.igState(commentId)).toBe('visible');
    const res = await graph.fetch(`https://graph.facebook.com/v26.0/${commentId}?fields=id`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(res.status).toBe(400);
  });

  it('subscribes the linked Page and honours token revocation and failNext', async () => {
    const { graph, pageId, igUserId, call } = world();
    await graphRequest(call, {
      method: 'POST',
      path: ['me', 'subscribed_apps'],
      form: { subscribed_fields: 'feed,comments' },
    });
    expect(graph.subscribedFields(pageId)).toEqual(['feed', 'comments']);
    const { commentId } = graph.addIgComment(igUserId);
    graph.failNext(4);
    await expect(
      graphRequest(call, { method: 'GET', path: [commentId], query: { fields: 'id' } }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
    graph.revokePageToken(pageId);
    await expect(
      graphRequest(call, { method: 'GET', path: [commentId], query: { fields: 'id' } }),
    ).rejects.toMatchObject({ kind: 'auth_expired' });
  });
});

async function userTokenFor(graph: FakeGraph, userId: string): Promise<string> {
  // Consent + code exchange + long-lived exchange, the same path the OAuth flow takes.
  const { createHash } = await import('node:crypto');
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
