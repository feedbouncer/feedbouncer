import { ConnectorError, systemClock, type Clock, type Connector } from '@feedbouncer/connectors';
import { buildAuthorizationUrl, exchangeCode } from '@feedbouncer/connector-facebook';
import { listAdAccounts } from './accounts.js';
import { listActiveAds } from './ads.js';
import { META_ADS_SCOPES, type MetaAdsConfig } from './config.js';

const noAction = () => Promise.reject(new ConnectorError('unsupported', 'no_actions'));
const noComments = () =>
  Promise.reject(new ConnectorError('unsupported', 'comments_via_page_connection'));

/** Lists ad accounts and their active ads. Comments are read through the Page or Instagram connection. */
export function createMetaAdsConnector(
  cfg: MetaAdsConfig,
  opts: { clock?: Clock } = {},
): Connector {
  const now = () => (opts.clock ?? systemClock).now();
  return {
    platform: 'meta_ads',
    capabilities: {
      actions: [],
      listSources: true,
      recentSources: false,
      ingestion: 'polling',
      accountSelection: 'multiple',
      tokens: { refreshable: false, rotatesRefreshToken: false },
      rateLimit: {
        points: 60,
        durationSec: 60,
        urgentReservePoints: 10,
        defaultRetryAfterMs: 300_000,
      },
      apiHosts: ['graph.facebook.com'],
      authorizationHosts: ['www.facebook.com'],
      defaultScopes: [...META_ADS_SCOPES],
      requiredScopes: [...META_ADS_SCOPES],
      maxPageSize: 100,
    },
    buildAuthorizationUrl: (i) => buildAuthorizationUrl(cfg.meta, i),
    exchangeCode: (input, ctx) => exchangeCode(cfg.meta, now, input, ctx),
    refreshTokens: () => Promise.reject(new ConnectorError('auth_expired', 'not_refreshable')),
    listAccounts: (token, ctx) => listAdAccounts(cfg, now, token, ctx),
    listSources: (ctx, req) => listActiveAds(cfg, now, ctx, req),
    listComments: noComments,
    getComment: noComments,
    act: noAction,
  };
}
