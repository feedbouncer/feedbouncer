import {
  ConnectorError,
  systemClock,
  type CallContext,
  type Clock,
  type Connector,
} from '@feedbouncer/connectors';
import { OPAQUE_ID, TIKTOK_API_HOST, tiktokRequest } from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';
import { act, respond } from './actions.js';
import { listAccounts } from './accounts.js';
import { getComment, listComments, listReplies } from './comments.js';
import { listSources } from './videos.js';
import type { SkipLog } from './call.js';
import { TIKTOK_ACTIONS, TIKTOK_SCOPES, type TikTokConfig } from './config.js';
import { buildAuthorizationUrl, exchangeCode, refreshTokens } from './oauth.js';

/** Best effort (Decision 13): a failed revoke is logged by code and never blocks disconnecting. */
async function revoke(cfg: TikTokConfig, ctx: CallContext, log: SkipLog): Promise<void> {
  try {
    await tiktokRequest(
      { http: ctx.http, signal: ctx.signal, accessToken: ctx.accessToken.reveal() },
      {
        endpoint: 'ttRevoke',
        method: 'POST',
        body: {
          client_id: cfg.appId,
          client_secret: cfg.appSecret,
          token: ctx.accessToken.reveal(),
        },
        schema: z.unknown(),
      },
    );
  } catch (err) {
    log('tiktok revoke failed', {
      code: err instanceof ConnectorError ? err.code : 'revoke_failed',
    });
  }
}

export function createTikTokConnector(
  cfg: TikTokConfig,
  opts: { clock?: Clock; log?: SkipLog } = {},
): Connector {
  const now = () => (opts.clock ?? systemClock).now();
  const log = opts.log ?? (() => {});
  return {
    platform: 'tiktok',
    capabilities: {
      actions: TIKTOK_ACTIONS,
      responses: ['public_reply'],
      actionScopes: {
        hide: ['comment.list.manage'],
        unhide: ['comment.list.manage'],
        delete: ['comment.list.manage'],
        public_reply: ['comment.list.manage'],
      },
      listSources: true,
      recentSources: false,
      ingestion: 'polling',
      accountSelection: 'multiple',
      accountIdPattern: OPAQUE_ID,
      oauthCodeParam: 'auth_code',
      tokens: { refreshable: true, rotatesRefreshToken: true },
      rateLimit: {
        points: 60,
        durationSec: 60,
        urgentReservePoints: 10,
        defaultRetryAfterMs: 60_000,
      },
      apiHosts: [TIKTOK_API_HOST],
      authorizationHosts: ['www.tiktok.com'],
      defaultScopes: [...TIKTOK_SCOPES],
      requiredScopes: [...TIKTOK_SCOPES],
      maxPageSize: 30,
    },
    buildAuthorizationUrl: (i) => buildAuthorizationUrl(cfg, i),
    exchangeCode: (input, ctx) => exchangeCode(cfg, now, input, ctx),
    refreshTokens: (token, ctx) => refreshTokens(cfg, now, token, ctx),
    listAccounts,
    listSources: (ctx, req) => listSources(log, ctx, req),
    listComments: (ctx, req) => listComments(log, ctx, req),
    listReplies: (ctx, req) => listReplies(log, ctx, req),
    getComment: (ctx, ref) => getComment(log, ctx, ref),
    act,
    respond,
    lifecycle: {
      onConnected: async () => {},
      onDisconnected: (ctx) => revoke(cfg, ctx, log),
    },
  };
}
