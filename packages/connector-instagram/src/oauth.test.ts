import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSafeHttp, type OAuthContext } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { buildAuthorizationUrl, exchangeCode } from '@feedbouncer/connector-facebook';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import { INSTAGRAM_SCOPES, type InstagramConfig } from './config.js';
import { listInstagramAccounts } from './oauth.js';

const APP_SECRET = 's'.repeat(32);
const cfg: InstagramConfig = {
  meta: {
    appId: '1234567',
    appSecret: new Secret(APP_SECRET),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  },
};
const now = () => Date.parse('2026-10-13T10:00:00Z');

/** A user with a long-lived token obtained through the fake's real consent/exchange flow. */
async function world(opts: { decline?: string[]; rewrite?: (body: unknown) => unknown } = {}) {
  const graph = new FakeGraph({ appSecret: APP_SECRET, appId: cfg.meta.appId });
  const { userId } = graph.addUser();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const res = await graph.fetch(input, init);
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!opts.rewrite || !url.pathname.endsWith('/me/accounts')) return res;
    return new Response(JSON.stringify(opts.rewrite(await res.json())), { status: res.status });
  };
  const ctx: OAuthContext = {
    http: createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch }),
    signal: AbortSignal.timeout(2000),
    redirectUri: 'https://app.test/api/v1/oauth/instagram/callback',
  };
  const verifier = 'v'.repeat(64);
  const url = buildAuthorizationUrl(cfg.meta, {
    state: 's'.repeat(43),
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    redirectUri: ctx.redirectUri,
    scopes: INSTAGRAM_SCOPES,
  });
  const { code } = graph.consent(url, userId, opts.decline ? { decline: opts.decline } : {});
  const { tokens } = await exchangeCode(
    cfg.meta,
    now,
    { code: new Secret(code), codeVerifier: new Secret(verifier) },
    ctx,
  );
  return { graph, userId, ctx, userToken: tokens.accessToken };
}

describe('listInstagramAccounts', () => {
  it('lists linked pages as eligible with the IG id and @username; unlinked pages as no_linked_instagram_account', async () => {
    const { graph, userId, ctx, userToken } = await world();
    const linked = graph.addPage(userId, { name: 'Shop', tasks: ['MODERATE', 'MESSAGING'] });
    const { igUserId } = graph.addInstagramAccount(linked.pageId, { username: 'shop.official' });
    const bare = graph.addPage(userId, { name: 'Blog', tasks: ['MODERATE'] });

    const out = await listInstagramAccounts(cfg, now, userToken, ctx);

    expect(out).toHaveLength(2);
    const ig = out.find((a) => a.externalAccountId === igUserId);
    expect(ig).toMatchObject({
      externalAccountId: igUserId,
      displayName: '@shop.official (via Shop)',
      eligible: true,
      ineligibleReason: null,
      limitations: [],
    });
    const unlinked = out.find((a) => a.externalAccountId === bare.pageId);
    expect(unlinked).toMatchObject({
      externalAccountId: bare.pageId,
      displayName: 'Blog',
      eligible: false,
      ineligibleReason: 'no_linked_instagram_account',
      limitations: [],
    });
  });

  it('a page without the MODERATE task is ineligible insufficient_page_role', async () => {
    const { graph, userId, ctx, userToken } = await world();
    const { pageId } = graph.addPage(userId, { name: 'Analyst', tasks: ['ANALYZE'] });
    const { igUserId } = graph.addInstagramAccount(pageId, { username: 'analyst' });

    const out = await listInstagramAccounts(cfg, now, userToken, ctx);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      externalAccountId: igUserId,
      displayName: '@analyst (via Analyst)',
      eligible: false,
      ineligibleReason: 'insufficient_page_role',
      limitations: [],
    });
  });

  it('marks messaging_permission_missing when instagram_manage_messages is not granted', async () => {
    const { graph, userId, ctx, userToken } = await world({
      decline: ['instagram_manage_messages'],
    });
    const { pageId } = graph.addPage(userId, { name: 'Shop', tasks: ['MODERATE'] });
    const { igUserId } = graph.addInstagramAccount(pageId, { username: 'shop' });

    const out = await listInstagramAccounts(cfg, now, userToken, ctx);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      externalAccountId: igUserId,
      displayName: '@shop (via Shop)',
      eligible: true,
      ineligibleReason: null,
      limitations: ['messaging_permission_missing'],
    });
  });

  it('returns each account with the Page token (never the user token)', async () => {
    const { graph, userId, ctx, userToken } = await world();
    const a = graph.addPage(userId, { name: 'A' });
    const b = graph.addPage(userId, { name: 'B' });
    const igA = graph.addInstagramAccount(a.pageId, { username: 'a' });

    const out = await listInstagramAccounts(cfg, now, userToken, ctx);

    const byId = new Map(out.map((x) => [x.externalAccountId, x.accessToken.reveal()]));
    expect(byId.get(igA.igUserId)).toBe(a.pageToken);
    expect(byId.get(b.pageId)).toBe(b.pageToken);
    for (const token of byId.values()) expect(token).not.toBe(userToken.reveal());
  });

  it('drops entries whose ids fail GRAPH_ID', async () => {
    const { graph, userId, ctx, userToken } = await world({
      rewrite: (body) => {
        const data = (body as { data: Record<string, unknown>[] }).data;
        return {
          data: data.map((p) =>
            p.name === 'Evil'
              ? { ...p, instagram_business_account: { id: '../x', username: 'e' } }
              : p,
          ),
        };
      },
    });
    const evil = graph.addPage(userId, { name: 'Evil' });
    graph.addInstagramAccount(evil.pageId, { username: 'e' });
    const fine = graph.addPage(userId, { name: 'Fine' });
    const { igUserId } = graph.addInstagramAccount(fine.pageId, { username: 'fine' });

    const out = await listInstagramAccounts(cfg, now, userToken, ctx);

    expect(out.map((a) => a.externalAccountId)).toEqual([igUserId]);
    expect(out[0]).toMatchObject({ displayName: '@fine (via Fine)', eligible: true });
  });

  it('a display name with markup is kept as plain text, capped at 200 chars', async () => {
    const { graph, userId, ctx, userToken } = await world();
    const markup = '<img src=x onerror=alert(1)>' + 'z'.repeat(400);
    const { pageId } = graph.addPage(userId, { name: markup });
    const { igUserId } = graph.addInstagramAccount(pageId, { username: 'shop' });

    const out = await listInstagramAccounts(cfg, now, userToken, ctx);

    expect(out).toHaveLength(1);
    expect(out[0]?.externalAccountId).toBe(igUserId);
    expect(out[0]?.displayName).toBe(`@shop (via ${markup.slice(0, 200)})`);
    expect(out[0]?.eligible).toBe(true);
    expect(out[0]?.ineligibleReason).toBeNull();
    expect(out[0]?.limitations).toEqual([]);
  });
});
