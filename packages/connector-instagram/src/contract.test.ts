import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStack } from '@feedbouncer/connectors/testing';
import type { Connector } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { createInstagramConnector } from './connector.js';

const APP_ID = '1234567';
const APP_SECRET = 'ig-app-secret-SENTINEL-0123456789';
let graph: FakeGraph;
let connector: Connector;
let stack: Awaited<ReturnType<typeof createMemoryStack>>;
let requests: { url: URL; headers: Headers }[];

beforeEach(async () => {
  graph = new FakeGraph({ appSecret: APP_SECRET, appId: APP_ID });
  requests = [];
  const recording: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    requests.push({ url, headers: new Headers(init?.headers) });
    return graph.fetch(input, init);
  };
  connector = createInstagramConnector({
    meta: {
      appId: APP_ID,
      appSecret: new Secret(APP_SECRET),
      graphVersion: 'v26.0',
      webhookVerifyToken: new Secret('v'.repeat(24)),
    },
  });
  stack = await createMemoryStack(connector, {
    webhookSecret: APP_SECRET,
    redirectUri: 'https://app.test/api/v1/oauth/instagram/callback',
    fetch: recording,
  });
});

/** A user with one Page; linked to an Instagram account unless `unlinked`. */
async function consentFor(opts: { decline?: string[]; tasks?: string[]; unlinked?: boolean } = {}) {
  const { userId } = graph.addUser('Dana');
  const { pageId, pageToken } = graph.addPage(userId, {
    tasks: opts.tasks ?? ['MODERATE', 'MESSAGING'],
    name: 'Shop',
  });
  const igUserId = opts.unlinked
    ? null
    : graph.addInstagramAccount(pageId, { username: 'shop.official' }).igUserId;
  const { authorizationUrl } = await stack.oauth.start(stack.actor, 'instagram');
  const { code, state } = graph.consent(
    authorizationUrl,
    userId,
    opts.decline ? { decline: opts.decline } : {},
  );
  const done = await stack.oauth.complete(stack.actor, 'instagram', { code, state });
  return { userId, pageId, pageToken, igUserId, done, authorizationUrl };
}

async function connectedClient() {
  const { userId, igUserId, pageId, pageToken, done } = await consentFor();
  const account = igUserId!;
  const r = await stack.oauth.connectAccounts(
    stack.actor,
    'instagram',
    (done as { grantId: string }).grantId,
    [account],
  );
  const connectionId = r.ok ? r.results[0]!.connectionId! : '';
  const scope = {
    organizationId: stack.actor.organizationId,
    brandId: stack.actor.brandId,
    connectionId,
  };
  return {
    userId,
    igUserId: account,
    pageId,
    pageToken,
    scope,
    client: await stack.runtime.connect(scope),
  };
}

describe('OAuth and account selection end to end', () => {
  it('connects the linked IG account and stores only the page token', async () => {
    const { igUserId, pageToken, done } = await consentFor();
    expect(done).toMatchObject({ ok: true, kind: 'account_selection' });
    const grantId = (done as { grantId: string }).grantId;
    const listed = await stack.oauth.listGrantAccounts(stack.actor, 'instagram', grantId);
    expect(listed).toMatchObject({
      ok: true,
      accounts: [
        {
          externalAccountId: igUserId,
          displayName: '@shop.official (via Shop)',
          eligible: true,
          connection: null,
        },
      ],
    });
    const r = await stack.oauth.connectAccounts(stack.actor, 'instagram', grantId, [igUserId!]);
    expect(r).toMatchObject({
      ok: true,
      results: [{ externalAccountId: igUserId, status: 'connected' }],
    });
    const connectionId = r.ok ? r.results[0]!.connectionId! : '';
    const tokens = await stack.vault.readTokens({
      organizationId: stack.actor.organizationId,
      brandId: stack.actor.brandId,
      connectionId,
    });
    expect(tokens.access?.value.reveal()).toBe(pageToken);
    expect(tokens.refresh).toBeNull();
  });

  it('a page with no linked IG account is listed ineligible and connecting it creates nothing (no partial connection)', async () => {
    const { pageId, done } = await consentFor({ unlinked: true });
    const grantId = (done as { grantId: string }).grantId;
    const listed = await stack.oauth.listGrantAccounts(stack.actor, 'instagram', grantId);
    expect(listed.ok && listed.accounts).toMatchObject([
      {
        externalAccountId: pageId,
        eligible: false,
        ineligibleReason: 'no_linked_instagram_account',
      },
    ]);
    const r = await stack.oauth.connectAccounts(stack.actor, 'instagram', grantId, [pageId]);
    expect(r).toMatchObject({
      ok: true,
      results: [{ externalAccountId: pageId, status: 'not_eligible' }],
    });
    expect(await stack.directory.findLiveByAccount('instagram', pageId)).toBeNull();
    expect(await stack.directory.findLiveByAccount('facebook', pageId)).toBeNull();
  });

  it('declining instagram_manage_comments -> missing_permissions; nothing stored', async () => {
    const { igUserId, done } = await consentFor({ decline: ['instagram_manage_comments'] });
    expect(done).toEqual({
      ok: false,
      reason: 'missing_permissions',
      missing: ['instagram_manage_comments'],
    });
    expect(await stack.directory.findLiveByAccount('instagram', igUserId!)).toBeNull();
  });

  it('declining only instagram_manage_messages connects with limitation messaging_permission_missing', async () => {
    const { igUserId, done } = await consentFor({ decline: ['instagram_manage_messages'] });
    expect(done).toMatchObject({ ok: true, kind: 'account_selection' });
    const grantId = (done as { grantId: string }).grantId;
    const listed = await stack.oauth.listGrantAccounts(stack.actor, 'instagram', grantId);
    expect(listed.ok && listed.accounts).toMatchObject([
      {
        externalAccountId: igUserId,
        eligible: true,
        limitations: ['messaging_permission_missing'],
      },
    ]);
    const r = await stack.oauth.connectAccounts(stack.actor, 'instagram', grantId, [igUserId!]);
    expect(r).toMatchObject({ ok: true, results: [{ status: 'connected' }] });
  });

  it('reconnect reuses the existing connection record', async () => {
    const first = await connectedClient();
    const { authorizationUrl } = await stack.oauth.start(stack.actor, 'instagram');
    const { code, state } = graph.consent(authorizationUrl, first.userId);
    const done = await stack.oauth.complete(stack.actor, 'instagram', { code, state });
    expect(done).toMatchObject({ ok: true, kind: 'account_selection' });
    const r = await stack.oauth.connectAccounts(
      stack.actor,
      'instagram',
      (done as { grantId: string }).grantId,
      [first.igUserId],
    );
    expect(r).toMatchObject({
      ok: true,
      results: [
        {
          externalAccountId: first.igUserId,
          status: 'reconnected',
          connectionId: first.scope.connectionId,
        },
      ],
    });
  });
});

describe('webhooks', () => {
  it('a signed instagram delivery is accepted and yields one comment.created', async () => {
    const { igUserId } = await connectedClient();
    const c = graph.addIgComment(igUserId, { text: 'nice' });
    const d = graph.signedInstagramDelivery(igUserId, [
      { commentId: c.commentId, mediaId: c.mediaId },
    ]);
    const seen: unknown[] = [];
    const result = await stack.webhooks.handle(
      { platform: 'instagram', connectionId: null, headers: d.headers, rawBody: d.rawBody },
      async (v) => {
        seen.push(...v.events);
      },
    );
    expect(result).toEqual({ status: 'accepted', eventCount: 1 });
    expect(seen).toEqual([
      expect.objectContaining({
        type: 'comment.created',
        externalAccountId: igUserId,
        ref: { sourceExternalId: c.mediaId, externalId: c.commentId },
      }),
    ]);
  });

  it('missing or wrong signature is rejected', async () => {
    const { igUserId } = await connectedClient();
    const c = graph.addIgComment(igUserId);
    const d = graph.signedInstagramDelivery(igUserId, [
      { commentId: c.commentId, mediaId: c.mediaId },
    ]);
    const req = {
      platform: 'instagram',
      connectionId: null,
      headers: d.headers,
      rawBody: d.rawBody,
    };
    let delivered = 0;
    const handler = async () => {
      delivered++;
    };
    expect(await stack.webhooks.handle({ ...req, headers: {} }, handler)).toEqual({
      status: 'rejected',
    });
    expect(
      await stack.webhooks.handle(
        { ...req, headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` } },
        handler,
      ),
    ).toEqual({ status: 'rejected' });
    const tampered = {
      ...req,
      rawBody: Buffer.from(d.rawBody.toString().replace(c.commentId, '1')),
    };
    expect(await stack.webhooks.handle(tampered, handler)).toEqual({ status: 'rejected' });
    expect(delivered).toBe(0);
  });

  it('the same body twice is a duplicate', async () => {
    const { igUserId } = await connectedClient();
    const c = graph.addIgComment(igUserId);
    const d = graph.signedInstagramDelivery(igUserId, [
      { commentId: c.commentId, mediaId: c.mediaId },
    ]);
    const req = {
      platform: 'instagram',
      connectionId: null,
      headers: d.headers,
      rawBody: d.rawBody,
    };
    expect((await stack.webhooks.handle(req, async () => {})).status).toBe('accepted');
    expect(await stack.webhooks.handle(req, async () => {})).toEqual({ status: 'duplicate' });
  });
});

describe('runtime through the connector', () => {
  it('setup subscribes comments; teardown removes only the instagram field', async () => {
    const { pageId, scope, client } = await connectedClient();
    graph.setSubscription(pageId, APP_ID, ['feed']);
    await client.setup();
    expect([...graph.subscribedFields(pageId)].sort()).toEqual(['comments', 'feed']);
    await stack.directory.disconnect(scope, stack.actor.userId);
    expect(await stack.runtime.teardown(scope)).toBe('done');
    expect(graph.subscribedFields(pageId)).toEqual(['feed']);
  });

  it('hides, replies and reads back through the runtime', async () => {
    const { igUserId, client } = await connectedClient();
    const c = graph.addIgComment(igUserId, { text: 'rude' });
    const target = { sourceExternalId: c.mediaId, externalId: c.commentId };
    expect(await client.getComment(target)).toMatchObject({
      body: 'rude',
      platformState: 'visible',
    });
    expect(await client.act({ action: 'hide', target })).toMatchObject({
      status: 'applied',
      undo: { action: 'unhide', target },
    });
    expect(graph.igState(c.commentId)).toBe('hidden');
    expect(await client.respond({ kind: 'private_reply', target, text: 'DM' })).toMatchObject({
      status: 'sent',
    });
    expect(graph.igPrivateReplies(c.commentId)).toEqual(['DM']);
  });

  it('a revoked page token marks the connection reconnect_required', async () => {
    const { igUserId, pageId, scope, client } = await connectedClient();
    const c = graph.addIgComment(igUserId);
    graph.revokePageToken(pageId, 460);
    await expect(
      client.getComment({ sourceExternalId: c.mediaId, externalId: c.commentId }),
    ).rejects.toMatchObject({ kind: 'auth_expired' });
    expect((await stack.directory.load(scope))?.status).toBe('reconnect_required');
  });
});

it('no issued secret ever appears in logs', async () => {
  const { igUserId, client } = await connectedClient();
  const c = graph.addIgComment(igUserId);
  graph.failNext(190, 463);
  await client.getComment({ sourceExternalId: c.mediaId, externalId: c.commentId }).catch(() => {});
  const logs = stack.lines.join('\n');
  expect(graph.issuedSecrets().length).toBeGreaterThan(0);
  for (const s of [...graph.issuedSecrets(), APP_SECRET]) expect(logs).not.toContain(s);
});

it('every request stays on graph.facebook.com with Bearer auth and appsecret_proof', async () => {
  const { igUserId, client } = await connectedClient();
  const c = graph.addIgComment(igUserId);
  const target = { sourceExternalId: c.mediaId, externalId: c.commentId };
  await client.getComment(target);
  await client.act({ action: 'hide', target });
  await client.respond({ kind: 'public_reply', target, text: 'thanks' });
  expect(requests.length).toBeGreaterThan(5);
  for (const { url, headers } of requests) {
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('graph.facebook.com');
    expect(url.searchParams.has('access_token')).toBe(false);
    // Only the code exchange is unauthenticated; it carries client credentials in the POST body.
    if (url.pathname.endsWith('/oauth/access_token')) continue;
    expect(headers.get('authorization')).toMatch(/^Bearer \S+$/);
    expect(url.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
  }
});

describe('listComments with inline replies through the runtime', () => {
  it('pages 100 top-level comments with many replies without loss, paying budget per request', async () => {
    const { igUserId, client } = await connectedClient();
    const first = graph.addIgComment(igUserId, { text: 't0' });
    const tops = [first.commentId];
    for (let t = 1; t < 100; t++) {
      tops.push(graph.addIgComment(igUserId, { mediaId: first.mediaId, text: `t${t}` }).commentId);
    }
    for (const p of tops) {
      for (let i = 0; i < 60; i++) {
        graph.addIgComment(igUserId, { mediaId: first.mediaId, parentId: p, text: `r${i}` });
      }
    }
    const acquire = vi.spyOn(stack.budget, 'acquire').mockResolvedValue({ granted: true });
    const requestsBefore = requests.length;
    const ids = new Set<string>();
    let cursor: string | null = null;
    let calls = 0;
    do {
      const page = await client.listComments({
        sourceExternalId: first.mediaId,
        cursor,
        includeReplies: true,
      });
      expect(page.items.length).toBeLessThanOrEqual(500);
      for (const c of page.items) ids.add(c.externalId);
      cursor = page.nextCursor;
      calls++;
    } while (cursor && calls < 500);
    expect(ids.size).toBe(100 * 61);
    const graphRequests = requests.length - requestsBefore;
    expect(graphRequests).toBe(calls);
    expect(acquire).toHaveBeenCalledTimes(calls);
  });
});
