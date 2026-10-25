// Threads OAuth: authorization code, then the short-lived token traded for a long-lived one.
// A long-lived token is its own refresh token (th_refresh_token), valid 60 days, so the access
// expiry is set a lead period early to make TokenManager refresh before the token dies.
// Errors come from `threadsRequest` and carry codes only; the app secret and the code travel in
// the request and never reach an error or a log. Tokens go in the bearer header; the only query
// secrets are client_secret (th_exchange_token) and input_token (debug_token), as the API requires.
import { ConnectorError, type TokenSet } from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import * as z from 'zod';
import { threadsRequest, type ThreadsCall } from './api.js';
import {
  THREADS_AUTHORIZATION_HOSTS,
  THREADS_SCOPES,
  THREADS_TOKEN_REFRESH_LEAD_SEC,
  type ThreadsConfig,
} from './config.js';
import { mediaId, sanitizeText } from './ids.js';

const AUTHORIZE_PATH = '/oauth/authorize';
const NAME_MAX_CODE_POINTS = 200;
const KNOWN_SCOPES: ReadonlySet<string> = new Set(THREADS_SCOPES);

export type ThreadsLog = (msg: string, fields: Record<string, unknown>) => void;

export function buildAuthorizationUrl(
  cfg: ThreadsConfig,
  o: { redirectUri: string; state: string; scopes: readonly string[] },
): URL {
  const u = new URL(AUTHORIZE_PATH, `https://${THREADS_AUTHORIZATION_HOSTS[0]}`);
  u.search = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: o.scopes.filter((s) => KNOWN_SCOPES.has(s)).join(','),
    state: o.state,
  }).toString();
  return u;
}

const SHORT_LIVED = z.object({ access_token: z.string().min(1).max(4096) });
const LONG_LIVED = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(31_536_000),
});
const DEBUG_TOKEN = z.object({
  data: z.object({ scopes: z.array(z.string().max(256)).max(100).optional() }),
});
const ME = z.object({
  id: z.unknown(),
  username: z.string().max(1000).optional(),
  name: z.string().max(10_000).optional(),
});

function toTokenSet(
  token: string,
  expiresInSec: number,
  now: Date,
  scopes: readonly string[],
): TokenSet {
  const lead = THREADS_TOKEN_REFRESH_LEAD_SEC;
  const accessSec = expiresInSec < 2 * lead ? expiresInSec / 2 : expiresInSec - lead;
  return {
    accessToken: new Secret(token),
    accessTokenExpiresAt: new Date(now.getTime() + accessSec * 1000),
    refreshToken: new Secret(token),
    refreshTokenExpiresAt: new Date(now.getTime() + expiresInSec * 1000),
    scopes,
  };
}

async function grantedScopes(
  call: ThreadsCall,
  longLived: string,
  log: ThreadsLog | undefined,
): Promise<readonly string[]> {
  try {
    const { data } = await threadsRequest(
      { ...call, accessToken: longLived },
      {
        endpoint: 'debugToken',
        method: 'GET',
        query: { input_token: longLived },
        schema: DEBUG_TOKEN,
      },
    );
    const granted = new Set(data.data.scopes ?? []);
    return THREADS_SCOPES.filter((s) => granted.has(s));
  } catch (e) {
    if (!(e instanceof ConnectorError) || e.kind !== 'permanent') throw e;
    log?.('threads.debug_token_unavailable', { code: e.code });
    return THREADS_SCOPES;
  }
}

export async function exchangeCode(
  cfg: ThreadsConfig,
  call: ThreadsCall,
  o: { code: string; redirectUri: string; now: Date; log?: ThreadsLog },
): Promise<{ tokens: TokenSet; account: { externalId: string; name: string } }> {
  const short = await threadsRequest(call, {
    endpoint: 'oauthToken',
    method: 'POST',
    form: {
      client_id: cfg.appId,
      client_secret: cfg.appSecret.reveal(),
      grant_type: 'authorization_code',
      redirect_uri: o.redirectUri,
      code: o.code,
    },
    schema: SHORT_LIVED,
  });
  const long = await threadsRequest(
    { ...call, accessToken: short.data.access_token },
    {
      endpoint: 'longLived',
      method: 'GET',
      query: { grant_type: 'th_exchange_token', client_secret: cfg.appSecret.reveal() },
      schema: LONG_LIVED,
    },
  );
  const token = long.data.access_token;
  const scopes = await grantedScopes(call, token, o.log);
  const account = await fetchMe({ ...call, accessToken: token });
  return {
    tokens: toTokenSet(token, long.data.expires_in, o.now, scopes),
    account: { externalId: account.id, name: account.name },
  };
}

/** The long-lived token is its own refresh token; the response carries no scopes. */
export async function refreshTokens(
  call: ThreadsCall,
  refreshToken: Secret,
  now: Date,
): Promise<TokenSet> {
  const { data } = await threadsRequest(
    { ...call, accessToken: refreshToken.reveal() },
    {
      endpoint: 'refresh',
      method: 'GET',
      query: { grant_type: 'th_refresh_token' },
      schema: LONG_LIVED,
    },
  );
  return toTokenSet(data.access_token, data.expires_in, now, []);
}

export async function fetchMe(call: ThreadsCall): Promise<{ id: string; name: string }> {
  const { data } = await threadsRequest(call, {
    endpoint: 'me',
    method: 'GET',
    query: { fields: 'id,username,name' },
    schema: ME,
  });
  const id = mediaId(data.id);
  const name = sanitizeText(data.name || data.username, NAME_MAX_CODE_POINTS).trim();
  return { id, name: name === '' ? id : name };
}
