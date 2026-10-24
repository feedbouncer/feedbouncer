// Marketing API OAuth (V11, V12). Secrets travel only in request bodies/queries built here;
// errors carry codes only.
import {
  ConnectorError,
  type AuthorizedAccount,
  type OAuthContext,
  type TokenSet,
} from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { tiktokRequest } from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';
import { TIKTOK_ADS_AUTHORIZE_URL, type TikTokAdsConfig } from './config.js';

/** The only place V12 corrections to the token response land. Expiry fields are optional. */
export const AD_TOKEN_SCHEMA = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096).optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
});
type AdToken = z.infer<typeof AD_TOKEN_SCHEMA>;

export function buildAuthorizationUrl(
  cfg: TikTokAdsConfig,
  i: { state: string; redirectUri: string },
): URL {
  const u = new URL(TIKTOK_ADS_AUTHORIZE_URL);
  u.searchParams.set('app_id', cfg.appId);
  u.searchParams.set('state', i.state);
  u.searchParams.set('redirect_uri', i.redirectUri);
  return u;
}

/** Expiry and refresh token are stored only when TikTok sent them (a non-expiring token has none). */
const toTokenSet = (nowMs: number, t: AdToken): TokenSet => ({
  accessToken: new Secret(t.access_token),
  accessTokenExpiresAt: t.expires_in === undefined ? null : new Date(nowMs + t.expires_in * 1000),
  refreshToken: t.refresh_token === undefined ? null : new Secret(t.refresh_token),
  refreshTokenExpiresAt:
    t.refresh_token === undefined || t.refresh_token_expires_in === undefined
      ? null
      : new Date(nowMs + t.refresh_token_expires_in * 1000),
  scopes: [],
});

/** The real accounts come from `listAccounts`; this one only stands for the grant. */
const GRANT_ACCOUNT: AuthorizedAccount = { externalAccountId: '0', displayName: null };

export async function exchangeCode(
  cfg: TikTokAdsConfig,
  now: () => number,
  input: { code: Secret },
  ctx: OAuthContext,
): Promise<{ tokens: TokenSet; account: AuthorizedAccount }> {
  const { data } = await tiktokRequest(
    { http: ctx.http, signal: ctx.signal },
    {
      endpoint: 'adOauthToken',
      method: 'POST',
      body: { app_id: cfg.appId, secret: cfg.appSecret, auth_code: input.code.reveal() },
      schema: AD_TOKEN_SCHEMA,
    },
  );
  return { tokens: toTokenSet(now(), data), account: GRANT_ACCOUNT };
}

export async function refreshTokens(
  cfg: TikTokAdsConfig,
  now: () => number,
  refreshToken: Secret,
  ctx: OAuthContext,
): Promise<TokenSet> {
  try {
    const { data } = await tiktokRequest(
      { http: ctx.http, signal: ctx.signal },
      {
        endpoint: 'adOauthRefresh',
        method: 'POST',
        body: { app_id: cfg.appId, secret: cfg.appSecret, refresh_token: refreshToken.reveal() },
        schema: AD_TOKEN_SCHEMA,
      },
    );
    return toTokenSet(now(), data);
  } catch (err) {
    if (err instanceof ConnectorError && err.kind === 'auth_expired') {
      throw new ConnectorError('auth_expired', 'refresh_rejected');
    }
    throw err;
  }
}
