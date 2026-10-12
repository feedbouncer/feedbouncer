// Reference connector over InMemoryPlatform. Two flavors with different
// shapes so the contract is not designed around one platform:
//   push: webhooks, rotating refresh tokens, all six actions
//   poll: polling only, non-rotating refresh tokens, hide + delete only
// It maps platform errors to the taxonomy exactly as real connectors must.
import { Secret } from '@feedbouncer/service-runtime';
import type { Connector, TokenSet } from '../connector.js';
import { ConnectorError } from '../errors.js';
import type { ModerationAction, NormalizedComment, Platform } from '../types.js';
import { PlatformError, type InMemoryPlatform, type RefComment } from './platform.js';

function mapError(err: unknown): never {
  if (err instanceof PlatformError) {
    if (err.status === 401) throw new ConnectorError('auth_expired', 'token_rejected');
    if (err.status === 400 && err.error === 'invalid_grant')
      throw new ConnectorError('auth_expired', 'invalid_grant');
    if (err.status === 404) throw new ConnectorError('not_found', 'not_found');
    if (err.status === 429)
      throw new ConnectorError('rate_limited', 'platform_throttled', {
        retryAfterMs: (err.retryAfterSec ?? 60) * 1000,
      });
    if (err.status === 503) throw new ConnectorError('transient', 'platform_unavailable');
    throw new ConnectorError('permanent', 'platform_rejected');
  }
  throw err;
}
const wrap = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    return mapError(e);
  }
};

const toTokens = (t: {
  accessToken: string;
  expiresAt: number;
  refreshToken: string | null;
}): TokenSet => ({
  accessToken: new Secret(t.accessToken),
  accessTokenExpiresAt: new Date(t.expiresAt),
  refreshToken: t.refreshToken ? new Secret(t.refreshToken) : null,
  refreshTokenExpiresAt: null,
  scopes: ['comments'],
});

const toComment = (c: RefComment): NormalizedComment => ({
  externalId: c.id,
  sourceExternalId: c.sourceId,
  parentExternalId: null,
  author: { externalId: c.authorId, displayName: c.authorName, profileUrl: null },
  body: c.body,
  postedAt: new Date(c.postedAt),
  platformState: c.state,
  permalink: `https://www.reference.test/c/${c.id}`,
});

export function createReferenceConnector(
  api: InMemoryPlatform,
  opts: { flavor: 'push' | 'poll'; platform?: Platform; redirectUri: string },
): Connector {
  const push = opts.flavor === 'push';
  const actions: ModerationAction[] = push
    ? ['hide', 'unhide', 'delete', 'report', 'ban_author', 'unban_author']
    : ['hide', 'delete'];
  const connector: Connector = {
    platform: opts.platform ?? (push ? 'facebook' : 'youtube'),
    capabilities: {
      actions,
      listSources: false,
      ingestion: push ? 'webhook' : 'polling',
      tokens: { refreshable: true, rotatesRefreshToken: push },
      rateLimit: {
        points: 20,
        durationSec: 60,
        urgentReservePoints: 5,
        defaultRetryAfterMs: 10_000,
      },
      apiHosts: ['api.reference.test'],
      authorizationHosts: ['auth.reference.test'],
      defaultScopes: ['comments'],
      maxPageSize: push ? 50 : 3,
    },
    buildAuthorizationUrl: ({ state, codeChallenge, redirectUri, scopes }) => {
      const u = new URL('https://auth.reference.test/authorize');
      u.search = new URLSearchParams({
        response_type: 'code',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: redirectUri,
        scope: scopes.join(' '),
      }).toString();
      return u;
    },
    async exchangeCode({ code, codeVerifier }, ctx) {
      const t = wrap(() =>
        api.tokenEndpoint({
          kind: 'code',
          code: code.reveal(),
          codeVerifier: codeVerifier.reveal(),
          redirectUri: ctx.redirectUri,
        }),
      );
      return {
        tokens: toTokens(t),
        account: { externalAccountId: t.accountId, displayName: `Account ${t.accountId}` },
      };
    },
    async refreshTokens(rt) {
      return toTokens(
        wrap(() => api.tokenEndpoint({ kind: 'refresh', refreshToken: rt.reveal() })),
      );
    },
    async listComments(ctx, req) {
      const page = wrap(() =>
        api.api(ctx.accessToken.reveal(), 'read', (acct) =>
          api.listComments(acct, req.sourceExternalId, req.cursor, req.limit),
        ),
      );
      return { items: page.items.map(toComment), nextCursor: page.next };
    },
    async getComment(ctx, ref) {
      const c = wrap(() =>
        api.api(ctx.accessToken.reveal(), 'read', (acct) =>
          api.getComment(acct, ref.sourceExternalId, ref.externalId),
        ),
      );
      return c ? toComment(c) : null;
    },
    async act(ctx, req) {
      const r = wrap(() =>
        api.api(ctx.accessToken.reveal(), 'act', (acct) =>
          api.apply(acct, req.target.sourceExternalId, req.target.externalId, req.action),
        ),
      );
      return r === 'applied'
        ? { status: 'applied', platformActionId: null }
        : { status: 'not_found' };
    },
  };
  if (!push) return connector;
  return {
    ...connector,
    webhook: {
      secretSource: 'app',
      signature: {
        header: 'x-ref-signature',
        prefix: 'sha256=',
        encoding: 'hex',
        timestampHeader: 'x-ref-timestamp',
        signedPayload: (body, ts) => Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), body]),
      },
      toleranceSec: 300,
      parse: (body) => {
        const j = JSON.parse(body.toString('utf8')) as {
          events: { account: string; source: string; comment: string; ts: number }[];
        };
        return j.events.map((e) => ({
          type: 'comment.created' as const,
          externalAccountId: e.account,
          ref: { sourceExternalId: e.source, externalId: e.comment },
          occurredAt: new Date(e.ts * 1000),
        }));
      },
    },
  };
}
