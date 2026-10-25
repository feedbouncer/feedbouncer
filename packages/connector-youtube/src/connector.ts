import {
  ConnectorError,
  systemClock,
  type CallContext,
  type Clock,
  type Connector,
} from '@feedbouncer/connectors';
import {
  API_HOSTS,
  AUTH_HOSTS,
  YOUTUBE_SCOPE_SHORT,
  type YouTubeConnectorConfig,
} from './config.js';
import { MAX_BATCH } from './costs.js';
import { CHANNEL_ID } from './ids.js';
import { act, actBatch, probeComments, YOUTUBE_ACTIONS } from './moderation.js';
import {
  buildAuthorizationUrl,
  exchangeCode,
  listAccounts,
  refreshTokens,
  revoke,
} from './oauth.js';
import {
  getComment,
  listChannelThreads,
  listThreadReplies,
  probeThreadReplyCounts,
} from './threads.js';

/** Codes and counts only: never a body, a URL or a token. */
export type YouTubeLog = (msg: string, fields: { code: string; count?: number }) => void;

/** Best effort: a failed revoke is logged by code and never blocks disconnecting. */
async function revokeGrant(ctx: CallContext, log: YouTubeLog): Promise<void> {
  try {
    await revoke(ctx, ctx.accessToken);
  } catch (err) {
    log('youtube revoke failed', {
      code: err instanceof ConnectorError ? err.code : 'revoke_failed',
    });
  }
}

export function createYouTubeConnector(
  cfg: YouTubeConnectorConfig,
  deps: { clock?: Clock; log?: YouTubeLog } = {},
): Connector {
  const now = () => (deps.clock ?? systemClock).now();
  const log = deps.log ?? (() => {});
  return {
    platform: 'youtube',
    capabilities: {
      actions: YOUTUBE_ACTIONS,
      listSources: false,
      recentSources: false,
      ingestion: 'polling',
      accountSelection: 'multiple',
      accountIdPattern: CHANNEL_ID,
      tokens: { refreshable: true, rotatesRefreshToken: false },
      rateLimit: {
        points: 10,
        durationSec: 1,
        urgentReservePoints: 2,
        defaultRetryAfterMs: 60_000,
      },
      apiHosts: API_HOSTS,
      authorizationHosts: AUTH_HOSTS,
      defaultScopes: [YOUTUBE_SCOPE_SHORT],
      requiredScopes: [YOUTUBE_SCOPE_SHORT],
      maxPageSize: 100,
      batchActions: { maxTargets: MAX_BATCH },
      actionDispatch: 'budgeted',
    },
    buildAuthorizationUrl: (i) => buildAuthorizationUrl(cfg, i),
    exchangeCode: (input, ctx) => exchangeCode(cfg, now, input, ctx),
    refreshTokens: (token, ctx) => refreshTokens(cfg, now, token, ctx),
    listAccounts: (token, ctx) => listAccounts(cfg, token, ctx),
    // The generic listing is the replies of one thread: `sourceExternalId` is the thread id.
    listComments: async (ctx, req) => {
      const { items, nextCursor, dropped } = await listThreadReplies(ctx, req);
      if (dropped > 0) log('youtube replies dropped', { code: 'invalid_reply', count: dropped });
      return { items, nextCursor };
    },
    // Inline replies are only the few Google embeds; the rest come from `listComments`.
    listThreads: async (ctx, req) => {
      const { items, nextCursor, dropped } = await listChannelThreads(ctx, req);
      if (dropped > 0) log('youtube threads dropped', { code: 'invalid_thread', count: dropped });
      return { items, nextCursor };
    },
    probeThreadReplyCounts,
    getComment,
    act,
    actBatch,
    probeComments,
    lifecycle: {
      onConnected: async () => {},
      onDisconnected: (ctx) => revokeGrant(ctx, log),
    },
  };
}
