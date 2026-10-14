import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  createSafeHttp,
  validateConnector,
  type CallContext,
  type Connector,
  type OAuthContext,
} from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { FakeGraph } from '@feedbouncer/connector-facebook/testing';
import type { MetaAdsConfig } from './config.js';
import { createMetaAdsConnector } from './connector.js';

const APP_SECRET = 's'.repeat(32);
const cfg: MetaAdsConfig = {
  meta: {
    appId: '1234567',
    appSecret: new Secret(APP_SECRET),
    graphVersion: 'v26.0',
    webhookVerifyToken: new Secret('v'.repeat(24)),
  },
  activeStatuses: ['ACTIVE'],
};
const VERIFIER = 'v'.repeat(48);
const now = () => 1_800_000_000_000;

let graph: FakeGraph;
let connector: Connector;
let userId: string;
let userToken: string;
let adAccountId: string;
let pageId: string;
let hosts: string[];
let ctx: CallContext;
let oauthCtx: OAuthContext;
let reportQuota: Mock<CallContext['reportQuota']>;

beforeEach(async () => {
  graph = new FakeGraph({ appSecret: APP_SECRET, appId: cfg.meta.appId });
  connector = createMetaAdsConnector(cfg, { clock: { now } });
  ({ userId } = graph.addUser());
  ({ pageId } = graph.addPage(userId));
  ({ adAccountId } = graph.addAdAccount(userId, { name: 'Main' }));
  hosts = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    hosts.push(new URL(String(input instanceof Request ? input.url : input)).host);
    return graph.fetch(input, init);
  };
  const http = createSafeHttp({ allowedHosts: ['graph.facebook.com'], fetch });
  oauthCtx = { http, signal: AbortSignal.timeout(5000), redirectUri: 'https://app.test/cb' };
  const url = connector.buildAuthorizationUrl({
    state: 'st',
    codeChallenge: createHash('sha256').update(VERIFIER).digest('base64url'),
    redirectUri: oauthCtx.redirectUri,
    scopes: connector.capabilities.defaultScopes,
  });
  const { code } = graph.consent(url, userId);
  const ex = await connector.exchangeCode(
    { code: new Secret(code), codeVerifier: new Secret(VERIFIER) },
    oauthCtx,
  );
  userToken = ex.tokens.accessToken.reveal();
  reportQuota = vi.fn<CallContext['reportQuota']>(async () => undefined);
  ctx = {
    accessToken: new Secret(userToken),
    externalAccountId: adAccountId,
    http,
    signal: AbortSignal.timeout(5000),
    reportQuota,
  };
});

describe('meta ads connector', () => {
  it('validates as a connector', () =>
    expect(() => validateConnector(createMetaAdsConnector(cfg))).not.toThrow());

  it('requests only ads_read', () => {
    expect(connector.capabilities.defaultScopes).toEqual(['ads_read']);
    expect(connector.capabilities.requiredScopes).toEqual(['ads_read']);
  });

  it('lists ad accounts for the picker with eligibility', async () => {
    graph.addAdAccount(userId, { name: 'Disabled', accountStatus: 2 });
    const accts = await connector.listAccounts!(new Secret(userToken), oauthCtx);
    expect(accts.map((a) => [a.eligible, a.ineligibleReason])).toEqual([
      [true, null],
      [false, 'ad_account_disabled'],
    ]);
    expect(accts.every((a) => /^\d+$/.test(a.externalAccountId))).toBe(true);
  });

  it('pages through 250 active ads and never follows paging.next', async () => {
    for (let i = 0; i < 250; i++) {
      graph.addAd(adAccountId, { storyId: graph.addDarkPost(pageId).postId });
    }
    const ids = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: Awaited<ReturnType<NonNullable<Connector['listSources']>>> =
        await connector.listSources!(ctx, { cursor });
      p.items.forEach((s) => ids.add(s.externalId));
      cursor = p.nextCursor;
      pages++;
    } while (cursor);
    expect(ids.size).toBe(250);
    expect(pages).toBe(3);
    expect(hosts.every((h) => h === 'graph.facebook.com')).toBe(true);
  });

  it('excludes paused ads via the status filter', async () => {
    const s = (st?: string) =>
      graph.addAd(adAccountId, {
        storyId: graph.addDarkPost(pageId).postId,
        ...(st ? { status: st } : {}),
      });
    s();
    s();
    s('PAUSED');
    const p = await connector.listSources!(ctx, { cursor: null });
    expect(p.items).toHaveLength(2);
    expect(p.items.every((i) => i.active && i.kind === 'ad_post')).toBe(true);
  });

  it.each([200, 10, 270])(
    'lost access (code %i) becomes auth_expired ads_permission_missing',
    async (code) => {
      graph.revokeAdAccountAccess(userId, adAccountId, code);
      await expect(connector.listSources!(ctx, { cursor: null })).rejects.toMatchObject({
        kind: 'auth_expired',
        code: 'ads_permission_missing',
      });
    },
  );

  it('a vanished ad account (100/33) is ads_permission_missing', async () => {
    graph.failNext(100, 33);
    await expect(connector.listSources!(ctx, { cursor: null })).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'ads_permission_missing',
    });
  });

  it('80004 is rate_limited with retryAfterMs', async () => {
    graph.throttleNext(80004, 2);
    await expect(connector.listSources!(ctx, { cursor: null })).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 120_000,
    });
  });

  it('high ad-account usage is reported as quota', async () => {
    graph.setAdAccountUsage(adAccountId, 95, 60);
    await connector.listSources!(ctx, { cursor: null });
    expect(reportQuota).toHaveBeenCalledWith({ remaining: 1, resetAt: new Date(now() + 60_000) });
  });

  it('never leaks a Graph error message or token', async () => {
    graph.failNext(1);
    const err: unknown = await connector.listSources!(ctx, { cursor: null }).catch(
      (e: unknown) => e,
    );
    expect(`${String(err)} ${JSON.stringify(err)}`).not.toMatch(/EAAB|token|SENTINEL/);
  });
});
