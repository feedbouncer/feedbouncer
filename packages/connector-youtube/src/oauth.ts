// Google OAuth 2.0 for web server apps, with PKCE. Secrets travel only in form
// bodies; errors carry a kind and a code, never Google's text.
import {
  ConnectorError,
  type CallContext,
  type GrantableAccount,
  type OAuthContext,
  type SafeHttp,
  type TokenSet,
} from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import * as z from 'zod';
import { youtubeCall } from './api.js';
import { YOUTUBE_SCOPE_SHORT, YOUTUBE_SCOPE_URL, type YouTubeConnectorConfig } from './config.js';
import { isId } from './ids.js';
import { cleanName } from './text.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** The connector's short scope names and the Google URLs they stand for. */
const SCOPE_URLS: Readonly<Record<string, string>> = { [YOUTUBE_SCOPE_SHORT]: YOUTUBE_SCOPE_URL };
const SCOPE_SHORT: ReadonlyMap<string, string> = new Map(
  Object.entries(SCOPE_URLS).map(([short, url]) => [url, short]),
);

const TOKEN = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(31_536_000),
  refresh_token: z.string().min(1).max(4096).optional(),
  scope: z.string().max(4096).optional(),
});
type GoogleToken = z.infer<typeof TOKEN>;
const TOKEN_ERROR = z.object({ error: z.string() });

export function buildAuthorizationUrl(
  cfg: YouTubeConnectorConfig,
  i: { state: string; codeChallenge: string; redirectUri: string; scopes: readonly string[] },
): URL {
  const scope = i.scopes
    .filter((s) => Object.hasOwn(SCOPE_URLS, s))
    .map((s) => SCOPE_URLS[s]!)
    .join(' ');
  const u = new URL(AUTHORIZE_URL);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: i.redirectUri,
    scope,
    state: i.state,
    code_challenge: i.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
  }).toString();
  return u;
}

/** Granted Google scope URLs to the connector's short names; anything else is dropped. */
const shortScopes = (scope: string | undefined): string[] => [
  ...new Set(
    (scope ?? '')
      .split(' ')
      .map((s) => SCOPE_SHORT.get(s))
      .filter((s): s is string => s !== undefined),
  ),
];

function tokenError(status: number, body: string): ConnectorError {
  if (status === 429) return new ConnectorError('rate_limited', 'rate_limited');
  if (status >= 500) return new ConnectorError('transient', 'platform_unavailable');
  let error: string | null = null;
  try {
    const parsed = TOKEN_ERROR.safeParse(JSON.parse(body));
    error = parsed.success ? parsed.data.error : null;
  } catch {
    error = null;
  }
  if (error === 'invalid_grant') {
    return new ConnectorError('auth_expired', 'refresh_token_revoked', { reauthorize: false });
  }
  return new ConnectorError('permanent', 'oauth_token_rejected');
}

async function postForm(
  ctx: { http: SafeHttp; signal: AbortSignal },
  url: string,
  form: Record<string, string>,
): Promise<string> {
  const res = await ctx.http.request(
    {
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    },
    ctx.signal,
  );
  if (res.status < 200 || res.status >= 300) throw tokenError(res.status, res.body);
  return res.body;
}

async function tokenRequest(ctx: OAuthContext, form: Record<string, string>): Promise<GoogleToken> {
  const body = await postForm(ctx, TOKEN_URL, form);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ConnectorError('permanent', 'invalid_platform_response');
  }
  const parsed = TOKEN.safeParse(json);
  if (!parsed.success) throw new ConnectorError('permanent', 'invalid_platform_response');
  return parsed.data;
}

const toTokenSet = (nowMs: number, t: GoogleToken, refresh: Secret | null): TokenSet => ({
  accessToken: new Secret(t.access_token),
  accessTokenExpiresAt: new Date(nowMs + t.expires_in * 1000),
  refreshToken: refresh,
  refreshTokenExpiresAt: null,
  scopes: shortScopes(t.scope),
});

/** No account: the channel is chosen through `listAccounts` (`accountSelection: 'multiple'`). */
export async function exchangeCode(
  cfg: YouTubeConnectorConfig,
  now: () => number,
  input: { code: Secret; codeVerifier: Secret },
  ctx: OAuthContext,
): Promise<{ tokens: TokenSet }> {
  const t = await tokenRequest(ctx, {
    grant_type: 'authorization_code',
    code: input.code.reveal(),
    code_verifier: input.codeVerifier.reveal(),
    redirect_uri: ctx.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret.reveal(),
  });
  // `access_type=offline` with `prompt=consent` always yields one; without it the
  // connection would die with its first access token.
  if (t.refresh_token === undefined) {
    throw new ConnectorError('permanent', 'refresh_token_missing');
  }
  return { tokens: toTokenSet(now(), t, new Secret(t.refresh_token)) };
}

/** Google does not rotate refresh tokens: `refreshToken: null` keeps the stored one. */
export async function refreshTokens(
  cfg: YouTubeConnectorConfig,
  now: () => number,
  refreshToken: Secret,
  ctx: OAuthContext,
): Promise<TokenSet> {
  const t = await tokenRequest(ctx, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken.reveal(),
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret.reveal(),
  });
  return toTokenSet(now(), t, t.refresh_token === undefined ? null : new Secret(t.refresh_token));
}

/** Revokes the grant behind an access or refresh token. Throws a code-only error on failure. */
export async function revoke(
  ctx: { http: SafeHttp; signal: AbortSignal },
  token: Secret,
): Promise<void> {
  await postForm(ctx, REVOKE_URL, { token: token.reveal() });
}

const CHANNELS = z.object({
  items: z
    .array(
      z.object({
        id: z.unknown(),
        snippet: z.object({ title: z.string().max(10_000).optional() }).optional(),
      }),
    )
    .max(50)
    .optional(),
});

/**
 * The channel(s) the user token can act for (`channels.list?mine=true`), metered on the
 * project quota as a `connect` call. A channel whose id fails `CHANNEL_ID` is dropped:
 * an id that cannot be validated cannot be offered, even as ineligible.
 */
export async function listAccounts(
  cfg: YouTubeConnectorConfig,
  userToken: Secret,
  ctx: OAuthContext,
): Promise<readonly GrantableAccount[]> {
  const call: CallContext = {
    accessToken: userToken,
    externalAccountId: '',
    http: ctx.http,
    signal: ctx.signal,
    reportQuota: async () => {},
    ...(cfg.projectQuota && { quota: cfg.projectQuota }),
  };
  const res = await youtubeCall(
    call,
    'channels.list',
    { mine: 'true', part: 'snippet' },
    CHANNELS,
    {
      purpose: 'connect',
    },
  );
  return (res?.items ?? []).flatMap((c) =>
    isId('channel', c.id)
      ? [
          {
            externalAccountId: c.id,
            displayName: cleanName(c.snippet?.title),
            eligible: true,
            ineligibleReason: null,
            limitations: [],
            accessToken: userToken,
          },
        ]
      : [],
  );
}
