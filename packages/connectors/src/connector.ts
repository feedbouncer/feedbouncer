import type { Secret } from '@feedbouncer/service-runtime';
import type { SafeHttp } from './http.js';
import type { QuotaMeter } from './quota.js';
import type {
  ActionRequest,
  AdLookup,
  CommentRef,
  ConnectorCapabilities,
  ModerationAction,
  NormalizedComment,
  NormalizedSource,
  RecentSource,
  Page,
  Platform,
  RespondRequest,
} from './types.js';

export interface OAuthContext {
  readonly http: SafeHttp;
  readonly signal: AbortSignal;
  readonly redirectUri: string;
}

export interface TokenSet {
  readonly accessToken: Secret;
  readonly accessTokenExpiresAt: Date | null;
  readonly refreshToken: Secret | null;
  readonly refreshTokenExpiresAt: Date | null;
  readonly scopes: readonly string[];
}

export interface AuthorizedAccount {
  readonly externalAccountId: string;
  readonly displayName: string | null;
}

export interface CallContext {
  readonly accessToken: Secret;
  readonly externalAccountId: string;
  readonly http: SafeHttp;
  readonly signal: AbortSignal;
  /** Best-effort: never rejects; if the budget store is down the report is logged and dropped. */
  reportQuota(q: { remaining: number; resetAt: Date }): Promise<void>;
  /** Set when the runtime meters this platform's daily quota; reserve before and settle after every call. */
  readonly quota?: QuotaMeter;
}

export type RawActionOutcome =
  | { readonly status: 'applied'; readonly platformActionId: string | null }
  | { readonly status: 'not_found' };

export interface BatchActionRequest {
  readonly action: ModerationAction;
  readonly targets: readonly CommentRef[];
}

export type BatchActionOutcome = { readonly status: 'applied' } | { readonly status: 'not_found' };

/** A top-level comment with its reply count and the replies the platform inlined. */
export interface NormalizedThread {
  /** Equals the top-level comment's external id. */
  readonly threadExternalId: string;
  readonly videoExternalId: string;
  readonly replyCount: number;
  /** The newest publish or update time of the top-level comment and its inline replies. */
  readonly lastActivityAt: Date;
  readonly topLevel: NormalizedComment;
  readonly replies: readonly NormalizedComment[];
}

export interface CommentProbe {
  readonly externalId: string;
  /** `gone`: deleted or rejected, no longer discoverable. */
  readonly state: 'visible' | 'held' | 'gone';
  readonly updatedAt: Date | null;
  readonly authorExternalId: string | null;
}

export type RawRespondOutcome =
  | { readonly status: 'sent'; readonly platformRef: string | null }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_eligible'; readonly code: string };

export interface GrantableAccount {
  readonly externalAccountId: string;
  readonly displayName: string | null;
  readonly eligible: boolean;
  /** snake_case code */
  readonly ineligibleReason: string | null;
  /** snake_case codes, e.g. `no_messaging_task` */
  readonly limitations: readonly string[];
  readonly accessToken: Secret;
}

export interface ConnectorLifecycle {
  /** Idempotent. Called by a job after every (re)connect. */
  onConnected(ctx: CallContext): Promise<void>;
  /** Idempotent, best-effort. Called after the connection is revoked locally. */
  onDisconnected(ctx: CallContext): Promise<void>;
}

export interface InboundEvent {
  readonly type: 'comment.created' | 'comment.updated' | 'comment.deleted';
  readonly externalAccountId: string;
  readonly ref: CommentRef;
  readonly occurredAt: Date;
}

export interface WebhookSpec {
  readonly secretSource: 'app' | 'connection';
  readonly signature: {
    readonly header: string;
    readonly prefix: string;
    readonly encoding: 'hex' | 'base64';
    readonly timestampHeader: string | null;
    signedPayload(rawBody: Buffer, timestamp: string | null): Buffer;
  };
  /** Accepted clock distance for the signed timestamp. Required with `timestampHeader`, unused without. */
  readonly toleranceSec?: number;
  /** Receives only bodies whose signature already verified. */
  parse(rawBody: Buffer): readonly InboundEvent[];
}

export interface ConnectionCommentsPage {
  /** `sourceExternalId` is set on each item. */
  readonly items: readonly NormalizedComment[];
  /** Every source referenced by `items`, deduplicated. */
  readonly sources: readonly NormalizedSource[];
  readonly hasMore: boolean;
}

export interface Connector {
  readonly platform: Platform;
  readonly capabilities: ConnectorCapabilities;

  /** Must include `state` verbatim and the S256 `codeChallenge`; host must be in `authorizationHosts`. */
  buildAuthorizationUrl(input: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    scopes: readonly string[];
  }): URL;

  /**
   * Throw `ConnectorError('auth_expired', …)` when the platform rejects the grant (e.g.
   * `invalid_grant`); `transient`/`rate_limited` for retryable failures.
   * `account` is required unless the connector lets the user pick among several accounts.
   */
  exchangeCode(
    input: { code: Secret; codeVerifier: Secret },
    ctx: OAuthContext,
  ): Promise<{ tokens: TokenSet; account?: AuthorizedAccount }>;

  /**
   * Throw `ConnectorError('auth_expired', …)` when the platform rejects the grant (e.g.
   * `invalid_grant`); `transient`/`rate_limited` for retryable failures.
   */
  refreshTokens(refreshToken: Secret, ctx: OAuthContext): Promise<TokenSet>;

  listSources?(ctx: CallContext, req: { cursor: string | null }): Promise<Page<NormalizedSource>>;

  /** One ad by id. A deleted ad is `deleted: true`, not an error; throttles and auth errors throw. */
  lookupAd?(ctx: CallContext, req: { externalId: string }): Promise<AdLookup>;

  /**
   * The connection's own posts/media, newest first. No item is older than
   * `since`, and `nextCursor` is null once the listing has passed `since`.
   */
  listRecentSources?(
    ctx: CallContext,
    req: { since: Date; cursor: string | null; limit: number },
  ): Promise<Page<RecentSource>>;

  /** Comments across the whole connection within `[since, until]`, paged by number. */
  listConnectionComments?(
    ctx: CallContext,
    req: { since: Date; until: Date; page: number; pageSize: number },
  ): Promise<ConnectionCommentsPage>;

  /** A comment deleted between pages must not fail the listing; return what still exists. */
  listComments(
    ctx: CallContext,
    req: {
      sourceExternalId: string;
      cursor: string | null;
      limit: number;
      /** Also return replies where the platform lists top-level comments only. Absent means false. */
      includeReplies?: boolean;
    },
  ): Promise<Page<NormalizedComment>>;

  /**
   * Replies under one comment. Implement when replies are not reachable through
   * `listComments({ sourceExternalId: commentId })`.
   */
  listReplies?(
    ctx: CallContext,
    req: { parent: CommentRef; cursor: string | null; limit: number },
  ): Promise<Page<NormalizedComment>>;

  getComment(ctx: CallContext, ref: CommentRef): Promise<NormalizedComment | null>;

  /**
   * Return `{status:'not_found'}` (or throw `not_found`) when the target no longer exists;
   * repeated hide on a hidden comment is `applied`.
   */
  act(ctx: CallContext, req: ActionRequest): Promise<RawActionOutcome>;

  /**
   * One platform call applying `action` to every target (at most `batchActions.maxTargets`).
   * `not_found` when the platform refuses the call because a target no longer exists.
   */
  actBatch?(ctx: CallContext, req: BatchActionRequest): Promise<BatchActionOutcome>;

  /** One page of the connected account's comment threads, newest first (polling platforms with a channel-wide feed). */
  listThreads?(ctx: CallContext, req: { cursor: string | null }): Promise<Page<NormalizedThread>>;

  /** Each thread's reply count in one call; threads the platform did not return are absent. */
  probeThreadReplyCounts?(
    ctx: CallContext,
    threadIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;

  /** Current state of each comment in one call; a comment the platform did not return is `gone`. */
  probeComments?(ctx: CallContext, refs: readonly CommentRef[]): Promise<readonly CommentProbe[]>;

  /**
   * Only for `accountSelection: 'multiple'`. Returns every account the user token can act for,
   * with that account's own token. Called twice per connect (list, then connect), never cached.
   */
  listAccounts?(userToken: Secret, ctx: OAuthContext): Promise<readonly GrantableAccount[]>;

  /**
   * Return `not_eligible` with a snake_case code when the platform refuses for a policy reason
   * (window closed, already replied). Never retry inside.
   */
  respond?(ctx: CallContext, req: RespondRequest): Promise<RawRespondOutcome>;

  readonly lifecycle?: ConnectorLifecycle;

  readonly webhook?: WebhookSpec;
}
