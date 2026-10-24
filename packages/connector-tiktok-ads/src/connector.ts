import { ConnectorError, systemClock, type Clock, type Connector } from '@feedbouncer/connectors';
import { NUMERIC_ID, TIKTOK_API_HOST, type SkipLog } from '@feedbouncer/tiktok-business-api';
import { act, respond } from './actions.js';
import { listAccounts } from './accounts.js';
import { getComment, listConnectionComments } from './comments.js';
import { TIKTOK_ADS_ACTIONS, TIKTOK_ADS_RESPONSES, type TikTokAdsConfig } from './config.js';
import { buildAuthorizationUrl, exchangeCode, refreshTokens } from './oauth.js';

export function createTikTokAdsConnector(
  cfg: TikTokAdsConfig,
  opts: { clock?: Clock; log?: SkipLog } = {},
): Connector {
  const now = () => (opts.clock ?? systemClock).now();
  const log = opts.log ?? (() => {});
  return {
    platform: 'tiktok_ads',
    capabilities: {
      actions: TIKTOK_ADS_ACTIONS,
      responses: TIKTOK_ADS_RESPONSES,
      listSources: false,
      recentSources: false,
      connectionComments: true,
      partialCommentLookup: true,
      ingestion: 'polling',
      accountSelection: 'multiple',
      accountIdPattern: NUMERIC_ID,
      oauthCodeParam: 'auth_code',
      tokens: { refreshable: true, rotatesRefreshToken: false },
      rateLimit: {
        points: 60,
        durationSec: 60,
        urgentReservePoints: 10,
        defaultRetryAfterMs: 60_000,
      },
      apiHosts: [TIKTOK_API_HOST],
      authorizationHosts: ['business-api.tiktok.com'],
      defaultScopes: [],
      maxPageSize: 100,
    },
    buildAuthorizationUrl: (i) => buildAuthorizationUrl(cfg, i),
    exchangeCode: (input, ctx) => exchangeCode(cfg, now, input, ctx),
    refreshTokens: (token, ctx) => refreshTokens(cfg, now, token, ctx),
    listAccounts: (token, ctx) => listAccounts(cfg, token, ctx),
    listConnectionComments: (ctx, req) => listConnectionComments(log, ctx, req),
    // Ad comments are only listed per connection; there is no per-source listing.
    listComments: () => Promise.reject(new ConnectorError('unsupported', 'listing_unsupported')),
    getComment: (ctx, ref) => getComment(log, now, ctx, ref),
    act,
    respond: (ctx, req) => respond(log, now, ctx, req),
    lifecycle: {
      onConnected: async () => {},
      // The Marketing API has no revoke endpoint.
      onDisconnected: async () => {},
    },
  };
}
