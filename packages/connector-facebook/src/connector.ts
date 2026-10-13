import { ConnectorError, systemClock, type Clock, type Connector } from '@feedbouncer/connectors';
import { act, lifecycle, respond } from './actions.js';
import { getComment, listComments } from './comments.js';
import { FACEBOOK_SCOPES, type FacebookConfig } from './config.js';
import { buildAuthorizationUrl, exchangeCode, listAccounts } from './oauth.js';
import { facebookWebhookSpec } from './webhook.js';

export function createFacebookConnector(
  cfg: FacebookConfig,
  opts: { clock?: Clock } = {},
): Connector {
  const now = () => (opts.clock ?? systemClock).now();
  return {
    platform: 'facebook',
    capabilities: {
      actions: ['hide', 'unhide', 'delete', 'ban_author', 'unban_author'],
      responses: ['public_reply', 'private_reply'],
      listSources: false,
      ingestion: 'webhook',
      accountSelection: 'multiple',
      tokens: { refreshable: false, rotatesRefreshToken: false },
      // Per Page per minute. Meta's Page BUC limit is per 24h and much larger; this keeps
      // one noisy Page from starving others and reserves room for moderation actions.
      rateLimit: {
        points: 200,
        durationSec: 60,
        urgentReservePoints: 50,
        defaultRetryAfterMs: 60_000,
      },
      apiHosts: ['graph.facebook.com'],
      authorizationHosts: ['www.facebook.com'],
      defaultScopes: [...FACEBOOK_SCOPES],
      requiredScopes: [...FACEBOOK_SCOPES],
      maxPageSize: 100,
    },
    buildAuthorizationUrl: (i) => buildAuthorizationUrl(cfg, i),
    exchangeCode: (i, ctx) => exchangeCode(cfg, now, i, ctx),
    refreshTokens: () => Promise.reject(new ConnectorError('auth_expired', 'not_refreshable')),
    listAccounts: (token, ctx) => listAccounts(cfg, now, token, ctx),
    listComments: (ctx, req) => listComments(cfg, now, ctx, req),
    getComment: (ctx, ref) => getComment(cfg, now, ctx, ref),
    act: (ctx, req) => act(cfg, now, ctx, req),
    respond: (ctx, req) => respond(cfg, now, ctx, req),
    lifecycle: lifecycle(cfg, now),
    webhook: facebookWebhookSpec,
  };
}
