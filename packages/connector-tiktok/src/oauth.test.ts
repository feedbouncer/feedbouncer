import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FakeTikTok } from '@feedbouncer/tiktok-business-api/testing';
import { createMemoryStack } from '@feedbouncer/connectors/testing';
import { createSafeHttp, type Connector, type OAuthContext } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { TIKTOK_API_HOST } from '@feedbouncer/tiktok-business-api';
import { TIKTOK_SCOPES } from './config.js';
import { createTikTokConnector } from './connector.js';

const APP = { appId: '7300000000000001', appSecret: 'tiktok-app-SECRET-0123456789' };
const REDIRECT = 'https://app.test/api/v1/oauth/tiktok/callback';
const NOW = new Date('2026-10-24T10:00:00Z');
let fake: FakeTikTok;
let connector: Connector;
let log: Mock<(msg: string, fields: { code: string }) => void>;
let ctx: OAuthContext;

beforeEach(() => {
  fake = new FakeTikTok({ ...APP, now: () => NOW });
  log = vi.fn<(msg: string, fields: { code: string }) => void>();
  connector = createTikTokConnector(
    { ...APP, appSecret: new Secret(APP.appSecret) },
    { clock: { now: () => NOW.getTime() }, log },
  );
  ctx = {
    http: createSafeHttp({ allowedHosts: [TIKTOK_API_HOST], fetch: fake.fetch }),
    signal: AbortSignal.timeout(2000),
    redirectUri: REDIRECT,
  };
});

const exchange = (authCode: string) =>
  connector.exchangeCode({ code: new Secret(authCode), codeVerifier: new Secret('v') }, ctx);

describe('buildAuthorizationUrl', () => {
  it('carries client_key, scopes and state; no secret', () => {
    const u = connector.buildAuthorizationUrl({
      state: 's'.repeat(43),
      codeChallenge: 'c'.repeat(43),
      redirectUri: REDIRECT,
      scopes: TIKTOK_SCOPES,
    });
    expect(u.origin + u.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_key: APP.appId,
      scope: TIKTOK_SCOPES.join(','),
      response_type: 'code',
      redirect_uri: REDIRECT,
      state: 's'.repeat(43),
    });
    expect(u.href).not.toContain(APP.appSecret);
  });
});

describe('exchangeCode', () => {
  it('stores refresh token expiry and granted scopes', async () => {
    const { businessId, authCode } = fake.addBusinessAccount({ username: 'shop' });
    const { tokens, account } = await exchange(authCode);
    expect(tokens.accessToken.reveal()).toMatch(/^tt_at_/);
    expect(tokens.refreshToken?.reveal()).toMatch(/^tt_rt_/);
    expect(tokens.accessTokenExpiresAt).toEqual(new Date(NOW.getTime() + 86400_000));
    expect(tokens.refreshTokenExpiresAt).toEqual(new Date(NOW.getTime() + 31536000_000));
    expect([...tokens.scopes]).toEqual([...TIKTOK_SCOPES]);
    expect(account).toEqual({ externalAccountId: businessId, displayName: 'shop' });
    const body = fake.calls('ttToken')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ grant_type: 'authorization_code', redirect_uri: REDIRECT });
  });

  it('a malformed open_id fails with invalid_tiktok_id', async () => {
    const { authCode } = fake.addBusinessAccount();
    const tampered: typeof globalThis.fetch = async (input, init) => {
      const res = await fake.fetch(input, init);
      if (!String(input).includes('/tt_user/oauth2/token/')) return res;
      const json = (await res.json()) as { data: Record<string, unknown> };
      return Response.json({ ...json, data: { ...json.data, open_id: 'bad/id' } });
    };
    const bad = {
      ...ctx,
      http: createSafeHttp({ allowedHosts: [TIKTOK_API_HOST], fetch: tampered }),
    };
    await expect(
      connector.exchangeCode({ code: new Secret(authCode), codeVerifier: new Secret('v') }, bad),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_tiktok_id' });
    expect(fake.calls('businessGet')).toHaveLength(0);
  });

  it('an unknown code is an error carrying a code only', async () => {
    await expect(exchange('nope')).rejects.toMatchObject({ kind: 'permanent' });
  });
});

describe('refreshTokens', () => {
  it('returns the rotated refresh token', async () => {
    const { tokens } = await exchange(fake.addBusinessAccount().authCode);
    const next = await connector.refreshTokens(tokens.refreshToken!, ctx);
    expect(next.refreshToken!.reveal()).not.toBe(tokens.refreshToken!.reveal());
    expect(next.accessToken.reveal()).not.toBe(tokens.accessToken.reveal());
    expect([...next.scopes]).toEqual([...TIKTOK_SCOPES]);
    expect(next.refreshTokenExpiresAt).toEqual(new Date(NOW.getTime() + 31536000_000));
  });

  it('a rejected refresh is auth_expired / refresh_rejected', async () => {
    await expect(connector.refreshTokens(new Secret('tt_rt_unknown'), ctx)).rejects.toMatchObject({
      kind: 'auth_expired',
      code: 'refresh_rejected',
    });
  });

  it('a throttled refresh stays retryable', async () => {
    fake.throttleNext('ttRefresh', 1);
    await expect(connector.refreshTokens(new Secret('x'), ctx)).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });
});

describe('lifecycle.onDisconnected', () => {
  const call = async (token: Secret, id: string) =>
    connector.lifecycle!.onDisconnected({
      accessToken: token,
      externalAccountId: id,
      http: ctx.http,
      signal: ctx.signal,
      reportQuota: async () => {},
    });

  it('revokes the token', async () => {
    const { businessId, authCode } = fake.addBusinessAccount();
    const { tokens } = await exchange(authCode);
    await call(tokens.accessToken, businessId);
    expect(fake.calls('ttRevoke')).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('swallows revoke failures and logs only the code', async () => {
    const { businessId, authCode } = fake.addBusinessAccount();
    const { tokens } = await exchange(authCode);
    fake.failNext('ttRevoke', { httpStatus: 500 });
    await expect(call(tokens.accessToken, businessId)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toEqual({ code: 'tiktok_unavailable' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(tokens.accessToken.reveal());
  });
});

describe('end to end through OAuthFlow', () => {
  it('fewer granted scopes surfaces missing_permissions', async () => {
    const stack = await createMemoryStack(connector, {
      webhookSecret: null,
      redirectUri: REDIRECT,
      fetch: fake.fetch,
    });
    const { authCode } = fake.addBusinessAccount({ scopes: ['comment.list'] });
    const { authorizationUrl } = await stack.oauth.start(stack.actor, 'tiktok');
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const done = await stack.oauth.complete(stack.actor, 'tiktok', { auth_code: authCode, state });
    expect(done).toMatchObject({ ok: false, reason: 'missing_permissions' });
    expect(
      done.ok === false && done.reason === 'missing_permissions' && [...done.missing].sort(),
    ).toEqual(['comment.list.manage', 'user.info.basic', 'video.list']);
  });
});
