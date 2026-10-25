import {
  ConnectorError,
  systemClock,
  type CallContext,
  type Clock,
  type Connector,
  type OAuthContext,
} from '@feedbouncer/connectors';
import type { Secret } from '@feedbouncer/service-runtime';
import { act, respond } from './actions.js';
import type { ThreadsCall } from './api.js';
import { listAccounts } from './accounts.js';
import {
  THREADS_ACTION_SCOPES,
  THREADS_ACTIVE_POST_DAYS,
  THREADS_API_HOST,
  THREADS_AUTHORIZATION_HOSTS,
  THREADS_MAX_REPLY_CHARS,
  THREADS_RATE_LIMIT,
  THREADS_REQUIRED_SCOPES,
  THREADS_SCOPES,
  type ThreadsConfig,
} from './config.js';
import { MEDIA_ID } from './ids.js';
import { buildAuthorizationUrl, exchangeCode, refreshTokens, type ThreadsLog } from './oauth.js';
import { getComment, getPostOwner, listComments, listReplies, listSources } from './reading.js';
import { threadsWebhookSpec } from './webhook.js';

const DAY_MS = 86_400_000;

const oauthCall = (ctx: OAuthContext): ThreadsCall => ({ http: ctx.http, signal: ctx.signal });
const callOf = (ctx: CallContext): ThreadsCall => ({
  http: ctx.http,
  signal: ctx.signal,
  accessToken: ctx.accessToken.reveal(),
});

export function createThreadsConnector(
  cfg: ThreadsConfig,
  deps: { clock?: Clock; log?: ThreadsLog } = {},
): Connector {
  const now = () => new Date((deps.clock ?? systemClock).now());
  const log: ThreadsLog = deps.log ?? (() => {});
  return {
    platform: 'threads',
    capabilities: {
      actions: ['hide', 'unhide'],
      responses: ['public_reply'],
      listSources: true,
      recentSources: false,
      ingestion: 'webhook_and_polling',
      tokens: { refreshable: true, rotatesRefreshToken: true },
      rateLimit: THREADS_RATE_LIMIT,
      apiHosts: [THREADS_API_HOST],
      authorizationHosts: [...THREADS_AUTHORIZATION_HOSTS],
      defaultScopes: [...THREADS_SCOPES],
      requiredScopes: [...THREADS_REQUIRED_SCOPES],
      actionScopes: THREADS_ACTION_SCOPES,
      accountSelection: 'multiple',
      accountIdPattern: MEDIA_ID,
      oauthCodeParam: 'code',
      constraints: {
        maxReplyChars: { public_reply: THREADS_MAX_REPLY_CHARS },
        hideTopLevelOnly: true,
        publicReplyOnHidden: true,
        hideOwnAccountComments: false,
      },
      responsePriority: 'bulk',
      maxPageSize: 100,
    },
    buildAuthorizationUrl: (i) => buildAuthorizationUrl(cfg, i),
    exchangeCode: async (input, ctx) => {
      const { tokens, account } = await exchangeCode(cfg, oauthCall(ctx), {
        code: input.code.reveal(),
        redirectUri: ctx.redirectUri,
        now: now(),
        log,
      });
      return {
        tokens,
        account: { externalAccountId: account.externalId, displayName: account.name },
      };
    },
    refreshTokens: (token: Secret, ctx) => refreshTokens(oauthCall(ctx), token, now()),
    listAccounts: (token: Secret, ctx) =>
      listAccounts({ ...oauthCall(ctx), accessToken: token.reveal() }),
    listSources: async (ctx, req) => {
      const since = new Date(now().getTime() - THREADS_ACTIVE_POST_DAYS * DAY_MS);
      try {
        const { sources, next } = await listSources(callOf(ctx), { since, cursor: req.cursor });
        return { items: sources, nextCursor: next };
      } catch (e) {
        // Without threads_basic the account's posts cannot be listed: the grant is incomplete.
        if (e instanceof ConnectorError && e.code === 'permission_denied') {
          throw new ConnectorError('auth_expired', e.code, {
            reauthorize: true,
            missingScopes: ['threads_basic'],
          });
        }
        throw e;
      }
    },
    listComments: async (ctx, req) => {
      const r = await listComments(callOf(ctx), {
        ownAccountExternalId: ctx.externalAccountId,
        sourceExternalId: req.sourceExternalId,
        cursor: req.cursor,
      });
      if (r.skippedInvalid > 0) {
        log('threads replies dropped', { code: 'invalid_reply', count: r.skippedInvalid });
      }
      if (r.skippedForeign > 0) {
        log('threads replies dropped', { code: 'foreign_reply', count: r.skippedForeign });
      }
      return { items: r.comments, nextCursor: r.next };
    },
    // First page only: enough to find our own published reply again.
    listReplies: async (ctx, req) => ({
      items: await listReplies(callOf(ctx), {
        ownAccountExternalId: ctx.externalAccountId,
        target: req.parent,
      }),
      nextCursor: null,
    }),
    getComment: (ctx, ref) =>
      getComment(callOf(ctx), { ownAccountExternalId: ctx.externalAccountId, ref }),
    verifySourceOwner: async (ctx, sourceExternalId) =>
      (await getPostOwner(callOf(ctx), sourceExternalId)) === ctx.externalAccountId,
    act: (ctx, req) => act(callOf(ctx), req),
    respond: (ctx, req) => respond({ ...callOf(ctx), userId: ctx.externalAccountId }, req),
    webhook: threadsWebhookSpec(cfg),
  };
}
