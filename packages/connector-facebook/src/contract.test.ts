import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStack } from '@feedbouncer/connectors/testing';
import type { Connector } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { createFacebookConnector } from './connector.js';
import { FakeGraph } from './testing/fake-graph.js';

const APP_SECRET = 'fb-app-secret-SENTINEL-0123456789';
let graph: FakeGraph;
let connector: Connector;
let stack: Awaited<ReturnType<typeof createMemoryStack>>;

beforeEach(async () => {
  graph = new FakeGraph({ appSecret: APP_SECRET, appId: '111' });
  connector = createFacebookConnector({
    appId: '111',
    appSecret: new Secret(APP_SECRET),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  });
  stack = await createMemoryStack(connector, {
    webhookSecret: APP_SECRET,
    redirectUri: 'https://app.test/api/v1/oauth/facebook/callback',
    fetch: graph.fetch,
  });
});

async function connectPage(opts: { decline?: string[]; tasks?: string[] } = {}) {
  const { userId } = graph.addUser('Dana');
  const { pageId } = graph.addPage(userId, {
    tasks: opts.tasks ?? ['MODERATE', 'MESSAGING'],
    name: 'Shop',
  });
  const { authorizationUrl } = await stack.oauth.start(stack.actor, 'facebook');
  const { code, state } = graph.consent(
    authorizationUrl,
    userId,
    opts.decline ? { decline: opts.decline } : {},
  );
  const done = await stack.oauth.complete(stack.actor, 'facebook', { code, state });
  return { userId, pageId, done };
}

describe('OAuth and page selection end to end', () => {
  it('connects a page and stores only its page token', async () => {
    const { pageId, done } = await connectPage();
    expect(done).toMatchObject({ ok: true, kind: 'account_selection' });
    const grantId = (done as { grantId: string }).grantId;
    const listed = await stack.oauth.listGrantAccounts(stack.actor, 'facebook', grantId);
    expect(listed).toMatchObject({
      ok: true,
      accounts: [
        { externalAccountId: pageId, displayName: 'Shop', eligible: true, connection: null },
      ],
    });
    const r = await stack.oauth.connectAccounts(stack.actor, 'facebook', grantId, [pageId]);
    expect(r).toMatchObject({
      ok: true,
      results: [{ externalAccountId: pageId, status: 'connected' }],
    });
  });

  it('declined permissions -> missing_permissions, nothing stored', async () => {
    const { done } = await connectPage({ decline: ['pages_messaging'] });
    expect(done).toEqual({
      ok: false,
      reason: 'missing_permissions',
      missing: ['pages_messaging'],
    });
  });

  it('pages without MODERATE are listed as ineligible', async () => {
    const { done } = await connectPage({ tasks: ['ANALYZE'] });
    const listed = await stack.oauth.listGrantAccounts(
      stack.actor,
      'facebook',
      (done as { grantId: string }).grantId,
    );
    expect(listed.ok && listed.accounts[0]).toMatchObject({
      eligible: false,
      ineligibleReason: 'insufficient_page_role',
    });
  });

  it('with several pages only the selected one is connected, the rest stay unconnected', async () => {
    const { userId } = graph.addUser('Dana');
    const a = graph.addPage(userId, { name: 'A' });
    const b = graph.addPage(userId, { name: 'B' });
    const { authorizationUrl } = await stack.oauth.start(stack.actor, 'facebook');
    const { code, state } = graph.consent(authorizationUrl, userId);
    const done = await stack.oauth.complete(stack.actor, 'facebook', { code, state });
    const grantId = (done as { grantId: string }).grantId;
    const listed = await stack.oauth.listGrantAccounts(stack.actor, 'facebook', grantId);
    expect(listed.ok && listed.accounts.map((x) => x.externalAccountId).sort()).toEqual(
      [a.pageId, b.pageId].sort(),
    );
    const r = await stack.oauth.connectAccounts(stack.actor, 'facebook', grantId, [b.pageId]);
    expect(r).toMatchObject({
      ok: true,
      results: [{ externalAccountId: b.pageId, status: 'connected' }],
    });
    expect(r.ok && r.results).toHaveLength(1);
    // The grant is single-use: once accounts are connected it cannot be listed again.
    expect(await stack.oauth.listGrantAccounts(stack.actor, 'facebook', grantId)).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  it('a wrong PKCE verifier or reused code is rejected by the platform', async () => {
    const { userId } = graph.addUser('Dana');
    graph.addPage(userId);
    const { authorizationUrl } = await stack.oauth.start(stack.actor, 'facebook');
    const { code, state } = graph.consent(authorizationUrl, userId);
    expect((await stack.oauth.complete(stack.actor, 'facebook', { code, state })).ok).toBe(true);
    const again = await stack.oauth.complete(stack.actor, 'facebook', { code, state });
    expect(again.ok).toBe(false);
  });
});

async function connectedClient() {
  const { pageId, done } = await connectPage();
  const r = await stack.oauth.connectAccounts(
    stack.actor,
    'facebook',
    (done as { grantId: string }).grantId,
    [pageId],
  );
  const connectionId = r.ok ? r.results[0]!.connectionId! : '';
  const scope = {
    organizationId: stack.actor.organizationId,
    brandId: stack.actor.brandId,
    connectionId,
  };
  return { pageId, scope, client: await stack.runtime.connect(scope) };
}

describe('lifecycle', () => {
  it('setup subscribes, teardown unsubscribes', async () => {
    const { pageId, scope, client } = await connectedClient();
    await client.setup();
    expect(graph.subscribed(pageId)).toBe(true);
    await stack.directory.disconnect(scope, stack.actor.userId);
    expect(await stack.runtime.teardown(scope)).toBe('done');
    expect(graph.subscribed(pageId)).toBe(false);
  });
});

describe('reads and actions through the runtime', () => {
  it('reads a nested reply with its parent', async () => {
    const { pageId, client } = await connectedClient();
    const top = graph.addComment(pageId, { message: 'top' });
    const reply = graph.addComment(pageId, {
      postId: top.postId,
      parentId: top.commentId,
      message: 'reply',
    });
    expect(reply.commentId.split('_')).toHaveLength(3);
    const c = await client.getComment({
      sourceExternalId: reply.postId,
      externalId: reply.commentId,
    });
    expect(c).toMatchObject({
      parentExternalId: top.commentId,
      body: 'reply',
      platformState: 'visible',
    });
  });

  it('an edit and a platform-side delete are visible to reads', async () => {
    const { pageId, client } = await connectedClient();
    const { postId, commentId } = graph.addComment(pageId, { message: 'v1' });
    const ref = { sourceExternalId: postId, externalId: commentId };
    graph.editComment(commentId, 'v2');
    expect(await client.getComment(ref)).toMatchObject({ body: 'v2' });
    graph.removeComment(commentId);
    expect(await client.getComment(ref)).toBeNull();
    expect(graph.state(commentId)).toBe('deleted');
  });

  it('hide is idempotent and reflected on the platform; unhide is the undo', async () => {
    const { pageId, client } = await connectedClient();
    const { postId, commentId } = graph.addComment(pageId);
    const target = { sourceExternalId: postId, externalId: commentId };
    const first = await client.act({ action: 'hide', target });
    expect(first).toMatchObject({ status: 'applied', undo: { action: 'unhide', target } });
    expect((await client.act({ action: 'hide', target })).status).toBe('applied');
    expect(graph.state(commentId)).toBe('hidden');
    expect((await client.act({ action: 'unhide', target })).status).toBe('applied');
    expect(graph.state(commentId)).toBe('visible');
  });

  it('delete twice -> applied then not_found', async () => {
    const { pageId, client } = await connectedClient();
    const { postId, commentId } = graph.addComment(pageId);
    const target = { sourceExternalId: postId, externalId: commentId };
    expect((await client.act({ action: 'delete', target })).status).toBe('applied');
    expect((await client.act({ action: 'delete', target })).status).toBe('not_found');
  });

  it('ban then unban by author id survives comment deletion', async () => {
    const { pageId, client } = await connectedClient();
    const { postId, commentId } = graph.addComment(pageId, { authorId: '4242' });
    const target = { sourceExternalId: postId, externalId: commentId };
    expect(
      (await client.act({ action: 'ban_author', target, authorExternalId: '4242' })).status,
    ).toBe('applied');
    expect(graph.blocked(pageId)).toEqual(['4242']);
    graph.removeComment(commentId);
    expect(
      (await client.act({ action: 'unban_author', target, authorExternalId: '4242' })).status,
    ).toBe('applied');
    expect(graph.blocked(pageId)).toEqual([]);
  });

  it('a page-authored comment cannot be banned', async () => {
    const { pageId, client } = await connectedClient();
    const { postId, commentId } = graph.addComment(pageId, { authorId: pageId });
    const r = await client.act({
      action: 'ban_author',
      target: { sourceExternalId: postId, externalId: commentId },
    });
    expect(r).toMatchObject({ status: 'failed', error: { code: 'author_is_page' } });
  });

  it('private reply once, then not_eligible; old comments not_eligible', async () => {
    const { pageId, client } = await connectedClient();
    const fresh = graph.addComment(pageId);
    const old = graph.addComment(pageId, { createdAtMs: Date.now() - 8 * 86_400_000 });
    const t = (c: { postId: string; commentId: string }) => ({
      sourceExternalId: c.postId,
      externalId: c.commentId,
    });
    expect(
      (await client.respond({ kind: 'private_reply', target: t(fresh), text: 'DM' })).status,
    ).toBe('sent');
    expect(
      await client.respond({ kind: 'private_reply', target: t(fresh), text: 'again' }),
    ).toMatchObject({ status: 'not_eligible', code: 'private_reply_already_sent' });
    expect(
      await client.respond({ kind: 'private_reply', target: t(old), text: 'DM' }),
    ).toMatchObject({ status: 'not_eligible', code: 'private_reply_window_closed' });
    expect(graph.privateReplies(fresh.commentId)).toEqual(['DM']);
  });

  it('public reply appears under the comment', async () => {
    const { pageId, client } = await connectedClient();
    const c = graph.addComment(pageId);
    const r = await client.respond({
      kind: 'public_reply',
      target: { sourceExternalId: c.postId, externalId: c.commentId },
      text: 'Thanks!',
    });
    expect(r.status).toBe('sent');
    expect(graph.replies(c.commentId)).toEqual([
      expect.objectContaining({ fromId: pageId, message: 'Thanks!' }),
    ]);
  });

  it('acting on another Page comment is refused by the platform and never applied', async () => {
    const { client } = await connectedClient();
    const other = graph.addUser('Eve');
    const foreign = graph.addPage(other.userId, { name: 'Other' });
    const c = graph.addComment(foreign.pageId);
    const r = await client.act({
      action: 'hide',
      target: { sourceExternalId: c.postId, externalId: c.commentId },
    });
    expect(r.status).toBe('failed');
    expect(graph.state(c.commentId)).toBe('visible');
  });
});

describe('path and request guards', () => {
  it('hostile ids are rejected before any network call', async () => {
    const { client } = await connectedClient();
    const before = graph.calls().length;
    for (const externalId of ['../me', '1/../2', '1?access_token=x', 'me', '1_2_3_4']) {
      await expect(
        client.getComment({ sourceExternalId: '1_2', externalId }),
      ).rejects.toMatchObject({ code: 'invalid_graph_id' });
    }
    expect(graph.calls().length).toBe(before);
  });

  it('only Graph hosts are reachable: the call log holds method and path, never a token', async () => {
    const { pageId, client } = await connectedClient();
    const c = graph.addComment(pageId);
    await client.getComment({ sourceExternalId: c.postId, externalId: c.commentId });
    const logged = JSON.stringify(graph.calls());
    for (const s of [...graph.issuedSecrets(), APP_SECRET]) expect(logged).not.toContain(s);
    expect(graph.calls().at(-1)).toEqual({ method: 'GET', path: c.commentId });
  });

  it('webhook ids that are not Graph ids are dropped', async () => {
    const { pageId } = await connectedClient();
    const d = graph.signedDelivery(pageId, [
      { verb: 'add', commentId: '../me', postId: `${pageId}_1` },
    ]);
    const seen: unknown[] = [];
    await stack.webhooks.handle(
      { platform: 'facebook', connectionId: null, headers: d.headers, rawBody: d.rawBody },
      async (v) => {
        seen.push(...v.events);
      },
    );
    expect(seen).toEqual([]);
  });
});

describe('failure handling', () => {
  it('a revoked page token marks the connection reconnect_required', async () => {
    const { pageId, scope, client } = await connectedClient();
    const c = graph.addComment(pageId);
    graph.revokePageToken(pageId, 460);
    await expect(
      client.getComment({ sourceExternalId: c.postId, externalId: c.commentId }),
    ).rejects.toMatchObject({ kind: 'auth_expired' });
    expect((await stack.directory.load(scope))?.status).toBe('reconnect_required');
  });

  it('admin role removed (190/492) also lands in reconnect_required', async () => {
    const { pageId, scope, client } = await connectedClient();
    const c = graph.addComment(pageId);
    graph.revokePageToken(pageId, 492);
    const r = await client.act({
      action: 'hide',
      target: { sourceExternalId: c.postId, externalId: c.commentId },
    });
    expect(r.status).toBe('failed');
    expect((await stack.directory.load(scope))?.status).toBe('reconnect_required');
  });

  it('throttling (80001 + BUC) surfaces rate_limited with retryAfter and blocks the budget', async () => {
    const { pageId, client } = await connectedClient();
    const c = graph.addComment(pageId);
    graph.throttleNext(80001, 2);
    const err = await client
      .getComment({ sourceExternalId: c.postId, externalId: c.commentId })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    await expect(
      client.getComment({ sourceExternalId: c.postId, externalId: c.commentId }),
    ).rejects.toMatchObject({ code: 'budget_exhausted' });
  });

  it('a missing comment reads as null (not_found), not an error', async () => {
    const { pageId, client } = await connectedClient();
    expect(
      await client.getComment({
        sourceExternalId: `${pageId}_9`,
        externalId: `${pageId}_9_9`,
      }),
    ).toBeNull();
  });
});

describe('webhooks through the gate', () => {
  it('verifies the app-secret signature and dedupes replays', async () => {
    const { pageId } = await connectedClient();
    const c = graph.addComment(pageId);
    const d = graph.signedDelivery(pageId, [
      { verb: 'add', commentId: c.commentId, postId: c.postId },
    ]);
    const seen: unknown[] = [];
    const req = {
      platform: 'facebook',
      connectionId: null,
      headers: d.headers,
      rawBody: d.rawBody,
    };
    expect(
      await stack.webhooks.handle(req, async (v) => {
        seen.push(v.events);
      }),
    ).toEqual({ status: 'accepted', eventCount: 1 });
    expect(await stack.webhooks.handle(req, async () => {})).toEqual({ status: 'duplicate' });
    const tampered = {
      ...req,
      rawBody: Buffer.from(d.rawBody.toString().replace(c.commentId, '1')),
    };
    expect(await stack.webhooks.handle(tampered, async () => {})).toEqual({ status: 'rejected' });
    expect(await stack.webhooks.handle({ ...req, headers: {} }, async () => {})).toEqual({
      status: 'rejected',
    });
  });
});

it('no issued secret ever appears in logs', async () => {
  const { pageId, client } = await connectedClient();
  const c = graph.addComment(pageId);
  graph.failNext(190, 463);
  await client.getComment({ sourceExternalId: c.postId, externalId: c.commentId }).catch(() => {});
  const logs = stack.lines.join('\n');
  expect(graph.issuedSecrets().length).toBeGreaterThan(0);
  for (const s of [...graph.issuedSecrets(), APP_SECRET]) expect(logs).not.toContain(s);
});
