import type { Secret } from '@feedbouncer/service-runtime';
import type { SafeHttp } from './http.js';
import type {
  ActionRequest,
  CommentRef,
  ConnectorCapabilities,
  NormalizedComment,
  NormalizedSource,
  Page,
  Platform,
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
  reportQuota(q: { remaining: number; resetAt: Date }): Promise<void>;
}

export type RawActionOutcome =
  | { readonly status: 'applied'; readonly platformActionId: string | null }
  | { readonly status: 'not_found' };

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
  readonly toleranceSec: number;
  /** Receives only bodies whose signature already verified. */
  parse(rawBody: Buffer): readonly InboundEvent[];
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
   */
  exchangeCode(
    input: { code: Secret; codeVerifier: Secret },
    ctx: OAuthContext,
  ): Promise<{ tokens: TokenSet; account: AuthorizedAccount }>;

  /**
   * Throw `ConnectorError('auth_expired', …)` when the platform rejects the grant (e.g.
   * `invalid_grant`); `transient`/`rate_limited` for retryable failures.
   */
  refreshTokens(refreshToken: Secret, ctx: OAuthContext): Promise<TokenSet>;

  listSources?(ctx: CallContext, req: { cursor: string | null }): Promise<Page<NormalizedSource>>;

  /** A comment deleted between pages must not fail the listing; return what still exists. */
  listComments(
    ctx: CallContext,
    req: { sourceExternalId: string; cursor: string | null; limit: number },
  ): Promise<Page<NormalizedComment>>;

  getComment(ctx: CallContext, ref: CommentRef): Promise<NormalizedComment | null>;

  /**
   * Return `{status:'not_found'}` (or throw `not_found`) when the target no longer exists;
   * repeated hide on a hidden comment is `applied`.
   */
  act(ctx: CallContext, req: ActionRequest): Promise<RawActionOutcome>;

  readonly webhook?: WebhookSpec;
}
