import { ConnectorError, systemClock, type Clock, type Connector } from '@feedbouncer/connectors';
import { buildAuthorizationUrl, exchangeCode } from '@feedbouncer/connector-facebook';
import { act, IG_LIMITS, lifecycle, respond } from './actions.js';
import { getComment, listComments, listReplies } from './comments.js';
import { INSTAGRAM_REQUIRED_SCOPES, INSTAGRAM_SCOPES, type InstagramConfig } from './config.js';
import { listInstagramAccounts } from './oauth.js';
import { listRecentMedia } from './sources.js';
import { instagramWebhookSpec } from './webhook.js';

export function createInstagramConnector(
  cfg: InstagramConfig,
  opts: { clock?: Clock } = {},
): Connector {
  const now = () => (opts.clock ?? systemClock).now();
  return {
    platform: 'instagram',
    capabilities: {
      actions: ['hide', 'unhide', 'delete'],
      responses: ['public_reply', 'private_reply'],
      listSources: false,
      recentSources: true,
      ingestion: 'webhook',
      accountSelection: 'multiple',
      tokens: { refreshable: false, rotatesRefreshToken: false },
      // Same budget shape as the Facebook connector: per account per minute, with a
      // reserve so moderation actions are not starved by reads.
      rateLimit: {
        points: 200,
        durationSec: 60,
        urgentReservePoints: 50,
        defaultRetryAfterMs: 60_000,
      },
      apiHosts: ['graph.facebook.com'],
      authorizationHosts: ['www.facebook.com'],
      defaultScopes: [...INSTAGRAM_SCOPES],
      requiredScopes: [...INSTAGRAM_REQUIRED_SCOPES],
      maxPageSize: 100,
      constraints: {
        privateReplyWindowMs: 7 * 86_400_000,
        privateReplyTopLevelOnly: true,
        publicReplyOnHidden: false,
        hideOwnAccountComments: false,
        maxReplyChars: { ...IG_LIMITS },
      },
    },
    buildAuthorizationUrl: (i) => buildAuthorizationUrl(cfg.meta, i),
    exchangeCode: (input, ctx) => exchangeCode(cfg.meta, now, input, ctx),
    refreshTokens: () => Promise.reject(new ConnectorError('auth_expired', 'not_refreshable')),
    listAccounts: (token, ctx) => listInstagramAccounts(cfg, now, token, ctx),
    listComments: (ctx, req) => listComments(cfg, now, ctx, req),
    listRecentSources: (ctx, req) => listRecentMedia(cfg, now, ctx, req),
    listReplies: (ctx, req) => listReplies(cfg, now, ctx, req),
    getComment: (ctx, ref) => getComment(cfg, now, ctx, ref),
    act: act(cfg, now),
    respond: respond(cfg, now),
    lifecycle: lifecycle(cfg, now),
    webhook: instagramWebhookSpec,
  };
}
