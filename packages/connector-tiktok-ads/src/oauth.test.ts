import { describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { TIKTOK_ADS_AUTHORIZE_URL } from './config.js';
import { APP, NOW, world } from './test-world.js';

describe('buildAuthorizationUrl', () => {
  it('carries app_id, state and redirect_uri; no secret', async () => {
    const { connector } = await world();
    const u = connector.buildAuthorizationUrl({
      state: 's'.repeat(43),
      codeChallenge: 'c'.repeat(43),
      redirectUri: 'https://app.test/cb',
      scopes: [],
    });
    expect(u.origin + u.pathname).toBe(TIKTOK_ADS_AUTHORIZE_URL);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      app_id: APP.appId,
      state: 's'.repeat(43),
      redirect_uri: 'https://app.test/cb',
    });
    expect(u.href).not.toContain(APP.appSecret);
  });
});

describe('exchangeCode', () => {
  it('exchangeCode with a non-expiring token stores no expiry and no refresh token', async () => {
    const { tokens, fake } = await world();
    expect(tokens.accessToken.reveal()).toMatch(/^ad_at_/);
    expect(tokens.accessTokenExpiresAt).toBeNull();
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.refreshTokenExpiresAt).toBeNull();
    expect(tokens.scopes).toEqual([]);
    expect(fake.calls('adOauthToken')[0]!.body).toMatchObject({
      app_id: APP.appId,
      secret: APP.appSecret,
    });
  });

  it('withExpiringAdsTokens: stores expiry and refreshes', async () => {
    const { tokens, connector, oauth } = await world((f) => f.withExpiringAdsTokens());
    expect(tokens.accessTokenExpiresAt).toEqual(new Date(NOW.getTime() + 86400_000));
    expect(tokens.refreshTokenExpiresAt).toEqual(new Date(NOW.getTime() + 31536000_000));
    const next = await connector.refreshTokens(tokens.refreshToken!, oauth);
    expect(next.refreshToken!.reveal()).not.toBe(tokens.refreshToken!.reveal());
    expect(next.accessToken.reveal()).not.toBe(tokens.accessToken.reveal());
  });

  it('a rejected refresh is auth_expired / refresh_rejected', async () => {
    const { connector, oauth } = await world();
    await expect(connector.refreshTokens(new Secret('ad_rt_unknown'), oauth)).rejects.toMatchObject(
      { kind: 'auth_expired', code: 'refresh_rejected' },
    );
  });

  it('an unknown code is an error carrying a code only', async () => {
    const { connector, oauth } = await world();
    await expect(
      connector.exchangeCode({ code: new Secret('nope'), codeVerifier: new Secret('v') }, oauth),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });
});
