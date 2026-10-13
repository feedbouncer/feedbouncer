// Facebook Login: authorization URL, code exchange (short -> long-lived user
// token) and Page listing. Secrets only travel in POST bodies or the
// Authorization header; Graph error messages are never read (see graph.ts).
import {
  ConnectorError,
  type AuthorizedAccount,
  type GrantableAccount,
  type OAuthContext,
  type TokenSet,
} from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import * as z from 'zod';
import type { FacebookConfig } from './config.js';
import { GRAPH_ID, graphRequest, type GraphCall } from './graph.js';

const MAX_PAGES_OF_ACCOUNTS = 10;

export function buildAuthorizationUrl(
  cfg: FacebookConfig,
  i: { state: string; codeChallenge: string; redirectUri: string; scopes: readonly string[] },
): URL {
  const u = new URL(`https://www.facebook.com/${cfg.graphVersion}/dialog/oauth`);
  u.searchParams.set('client_id', cfg.appId);
  u.searchParams.set('redirect_uri', i.redirectUri);
  u.searchParams.set('state', i.state);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', i.scopes.join(','));
  // Re-asks permissions the user declined earlier; without it Facebook silently skips them.
  u.searchParams.set('auth_type', 'rerequest');
  u.searchParams.set('code_challenge', i.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u;
}

const call = (
  cfg: FacebookConfig,
  ctx: OAuthContext,
  nowMs: () => number,
  token: Secret | null,
): GraphCall => ({
  http: ctx.http,
  signal: ctx.signal,
  version: cfg.graphVersion,
  appSecret: cfg.appSecret,
  token,
  nowMs,
});

const tokenResponse = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().optional(),
});
const meResponse = z.object({
  id: z.string().regex(GRAPH_ID),
  name: z.string().max(500).optional(),
});
const permissionsResponse = z.object({
  data: z
    .array(z.object({ permission: z.string().regex(/^[a-z_]{1,64}$/), status: z.string() }))
    .max(200),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ConnectorError('permanent', 'invalid_graph_response');
  return r.data;
}

export async function exchangeCode(
  cfg: FacebookConfig,
  nowMs: () => number,
  input: { code: Secret; codeVerifier: Secret },
  ctx: OAuthContext,
): Promise<{ tokens: TokenSet; account: AuthorizedAccount }> {
  const anon = call(cfg, ctx, nowMs, null);
  const short = parse(
    tokenResponse,
    (
      await graphRequest(anon, {
        method: 'POST',
        path: ['oauth', 'access_token'],
        form: {
          client_id: cfg.appId,
          client_secret: cfg.appSecret.reveal(),
          redirect_uri: ctx.redirectUri,
          code: input.code.reveal(),
          code_verifier: input.codeVerifier.reveal(),
        },
      })
    ).body,
  );
  const long = parse(
    tokenResponse,
    (
      await graphRequest(anon, {
        method: 'POST',
        path: ['oauth', 'access_token'],
        form: {
          grant_type: 'fb_exchange_token',
          client_id: cfg.appId,
          client_secret: cfg.appSecret.reveal(),
          fb_exchange_token: short.access_token,
        },
      })
    ).body,
  );
  const userToken = new Secret(long.access_token);
  const authed = call(cfg, ctx, nowMs, userToken);
  const me = parse(
    meResponse,
    (await graphRequest(authed, { method: 'GET', path: ['me'], query: { fields: 'id,name' } }))
      .body,
  );
  const perms = parse(
    permissionsResponse,
    (await graphRequest(authed, { method: 'GET', path: ['me', 'permissions'] })).body,
  );
  return {
    tokens: {
      accessToken: userToken,
      accessTokenExpiresAt: long.expires_in ? new Date(nowMs() + long.expires_in * 1000) : null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
      scopes: perms.data.filter((p) => p.status === 'granted').map((p) => p.permission),
    },
    account: { externalAccountId: me.id, displayName: me.name ?? null },
  };
}

const accountsPage = z.object({
  data: z.array(z.unknown()).max(200),
  paging: z
    .object({
      cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});
const accountEntry = z.object({
  id: z.string().regex(GRAPH_ID),
  name: z.string().max(500).optional(),
  tasks: z.array(z.string().max(64)).max(50).default([]),
  access_token: z.string().min(1).max(4096),
});

export async function listAccounts(
  cfg: FacebookConfig,
  nowMs: () => number,
  userToken: Secret,
  ctx: OAuthContext,
): Promise<readonly GrantableAccount[]> {
  const c = call(cfg, ctx, nowMs, userToken);
  const out: GrantableAccount[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGES_OF_ACCOUNTS; i++) {
    const page: z.infer<typeof accountsPage> = parse(
      accountsPage,
      (
        await graphRequest(c, {
          method: 'GET',
          path: ['me', 'accounts'],
          query: {
            fields: 'id,name,tasks,access_token',
            limit: '100',
            ...(after ? { after } : {}),
          },
        })
      ).body,
    );
    for (const raw of page.data) {
      const e = accountEntry.safeParse(raw);
      if (!e.success) continue; // one malformed page entry must not hide the others
      const moderate = e.data.tasks.includes('MODERATE');
      out.push({
        externalAccountId: e.data.id,
        displayName: e.data.name ?? null,
        eligible: moderate,
        ineligibleReason: moderate ? null : 'insufficient_page_role',
        limitations: e.data.tasks.includes('MESSAGING') ? [] : ['no_messaging_task'],
        accessToken: new Secret(e.data.access_token),
      });
    }
    // Follow the cursor, never the `next` URL: we rebuild the URL ourselves on the allowed host.
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}
