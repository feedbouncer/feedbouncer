// TikTok Accounts OAuth (V1-V3). Secrets travel only in POST bodies; errors carry codes only.
import {
  ConnectorError,
  type AuthorizedAccount,
  type OAuthContext,
  type TokenSet,
} from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import { opaqueId, tiktokRequest } from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';
import { fetchBusinessAccount } from './accounts.js';
import { TIKTOK_AUTHORIZE_URL, type TikTokConfig } from './config.js';

/** The only place V2/V3 corrections to the token response land. */
export const TT_TOKEN_SCHEMA = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive(),
  refresh_token_expires_in: z.number().int().positive(),
  open_id: z.string(),
  scope: z.string().max(1024),
});
type TtToken = z.infer<typeof TT_TOKEN_SCHEMA>;

export function buildAuthorizationUrl(
  cfg: TikTokConfig,
  i: { state: string; redirectUri: string; scopes: readonly string[] },
): URL {
  const u = new URL(TIKTOK_AUTHORIZE_URL);
  u.searchParams.set('client_key', cfg.appId);
  u.searchParams.set('scope', i.scopes.join(','));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', i.redirectUri);
  u.searchParams.set('state', i.state);
  return u;
}

const toTokenSet = (nowMs: number, t: TtToken): TokenSet => ({
  accessToken: new Secret(t.access_token),
  accessTokenExpiresAt: new Date(nowMs + t.expires_in * 1000),
  refreshToken: new Secret(t.refresh_token),
  refreshTokenExpiresAt: new Date(nowMs + t.refresh_token_expires_in * 1000),
  scopes: t.scope.split(',').filter(Boolean),
});

export async function exchangeCode(
  cfg: TikTokConfig,
  now: () => number,
  input: { code: Secret },
  ctx: OAuthContext,
): Promise<{ tokens: TokenSet; account: AuthorizedAccount }> {
  const { data } = await tiktokRequest(
    { http: ctx.http, signal: ctx.signal },
    {
      endpoint: 'ttToken',
      method: 'POST',
      body: {
        client_id: cfg.appId,
        client_secret: cfg.appSecret.reveal(),
        grant_type: 'authorization_code',
        auth_code: input.code.reveal(),
        redirect_uri: ctx.redirectUri,
      },
      schema: TT_TOKEN_SCHEMA,
    },
  );
  const tokens = toTokenSet(now(), data);
  const businessId = opaqueId(data.open_id);
  const { displayName } = await fetchBusinessAccount(ctx, tokens.accessToken, businessId);
  return { tokens, account: { externalAccountId: businessId, displayName } };
}

export async function refreshTokens(
  cfg: TikTokConfig,
  now: () => number,
  refreshToken: Secret,
  ctx: OAuthContext,
): Promise<TokenSet> {
  try {
    const { data } = await tiktokRequest(
      { http: ctx.http, signal: ctx.signal },
      {
        endpoint: 'ttRefresh',
        method: 'POST',
        body: {
          client_id: cfg.appId,
          client_secret: cfg.appSecret.reveal(),
          grant_type: 'refresh_token',
          refresh_token: refreshToken.reveal(),
        },
        schema: TT_TOKEN_SCHEMA,
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
