// Access-token lifecycle. Refresh is serialized per connection twice: an
// in-process single-flight map (concurrent callers share one promise) and a
// RefreshLock (cross-process; Postgres advisory lock in production). Inside
// the lock the vault is re-read, so a waiter reuses a token another process
// just stored. Rotation: the NEW refresh token is written (and committed)
// before the access token, so a failure in between never leaves only a dead
// refresh token. Rejected grants flag the connection once and stop.
import type { ConnectionScope } from '@feedbouncer/secrets';
import { Secret, type Logger } from '@feedbouncer/service-runtime';
import type { Clock } from './clock.js';
import type { Connector, OAuthContext, TokenSet } from './connector.js';
import { ConnectorError, toConnectorError } from './errors.js';
import { scopeKey } from './scope.js';
import type {
  ConnectionDirectory,
  CredentialVault,
  ReauthReason,
  RefreshLock,
  TokenRecord,
} from './ports.js';

const MAX_SCOPES = 100;
const SCOPE = /^[^\u0000-\u001f\u007f]{0,256}$/;
const validDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

/**
 * Checks a TokenSet from exchangeCode/refreshTokens before anything is stored.
 * Tokens must be Secrets and scopes bounded, else permanent/invalid_connector_output.
 * An unusable expiry becomes null (unknown) instead of failing: the platform may
 * already have rotated the refresh token, and losing the new one locks the
 * connection out.
 */
export function normalizeTokenSet(
  raw: unknown,
  log: Logger,
  fields: Readonly<Record<string, unknown>>,
): TokenSet {
  const t = (raw ?? {}) as Partial<Record<keyof TokenSet, unknown>>;
  const refreshToken = t.refreshToken ?? null;
  const scopes = t.scopes;
  if (
    !(t.accessToken instanceof Secret) ||
    (refreshToken !== null && !(refreshToken instanceof Secret)) ||
    !Array.isArray(scopes) ||
    scopes.length > MAX_SCOPES ||
    !scopes.every((x) => typeof x === 'string' && SCOPE.test(x))
  )
    throw new ConnectorError('permanent', 'invalid_connector_output');
  const expiry = (d: unknown): Date | null => {
    if (validDate(d)) return d;
    if (d != null)
      log.warn('connector returned an unusable token expiry', {
        ...fields,
        code: 'invalid_token_expiry',
      });
    return null;
  };
  return {
    accessToken: t.accessToken,
    accessTokenExpiresAt: expiry(t.accessTokenExpiresAt),
    refreshToken,
    refreshTokenExpiresAt: expiry(t.refreshTokenExpiresAt),
    scopes: scopes as string[],
  };
}

export interface TokenManagerDeps {
  vault: CredentialVault;
  directory: ConnectionDirectory;
  lock: RefreshLock;
  clock: Clock;
  log: Logger;
  oauthContext(connector: Connector): OAuthContext;
  skewMs?: number;
}

export class TokenManager {
  readonly #inflight = new Map<string, Promise<Secret>>();
  readonly #skew: number;
  constructor(private readonly d: TokenManagerDeps) {
    this.#skew = d.skewMs ?? 120_000;
  }

  async accessToken(
    connector: Connector,
    scope: ConnectionScope,
    opts: { rejected?: Secret } = {},
  ): Promise<Secret> {
    const { access } = await this.d.vault.readTokens(scope);
    if (access && this.#usable(access, opts.rejected)) return access.value;
    const key = scopeKey(scope);
    const existing = this.#inflight.get(key);
    if (existing) {
      this.d.log.info('token refresh joined', { ...ids(scope), waiter: 'in_process' });
      return existing;
    }
    const p = this.d.lock
      .run(scope, () => this.#refreshLocked(connector, scope, opts.rejected))
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }

  #usable(t: TokenRecord, rejected: Secret | undefined): boolean {
    if (rejected && t.value.equals(rejected)) return false;
    return t.expiresAt === null || t.expiresAt.getTime() - this.d.clock.now() > this.#skew;
  }

  async #refreshLocked(
    connector: Connector,
    scope: ConnectionScope,
    rejected: Secret | undefined,
  ): Promise<Secret> {
    const status = (await this.d.directory.load(scope))?.status;
    if (status !== 'active')
      // revoked is terminal and activation refuses paused: re-authorizing cannot fix either.
      throw new ConnectorError('auth_expired', 'connection_inactive', {
        reauthorize: status !== 'revoked' && status !== 'paused',
      });
    const { access, refresh } = await this.d.vault.readTokens(scope);
    if (access && this.#usable(access, rejected)) {
      this.d.log.info('token refresh reused', { ...ids(scope), waiter: 'cross_process' });
      return access.value;
    }
    const refreshExpired =
      refresh?.expiresAt != null && refresh.expiresAt.getTime() <= this.d.clock.now();
    if (!connector.capabilities.tokens.refreshable || !refresh || refreshExpired)
      return this.#reauth(scope, 'oauth_not_refreshable');

    let tokens: TokenSet;
    try {
      tokens = normalizeTokenSet(
        await connector.refreshTokens(refresh.value, this.d.oauthContext(connector)),
        this.d.log,
        ids(scope),
      );
    } catch (err) {
      const ce = toConnectorError(err);
      if (ce.kind === 'auth_expired') return this.#reauth(scope, 'oauth_refresh_rejected');
      this.d.log.warn('token refresh failed', { ...ids(scope), kind: ce.kind, errorCode: ce.code });
      throw ce;
    }
    if (tokens.refreshToken)
      await this.d.vault.writeRefreshToken(scope, {
        value: tokens.refreshToken,
        expiresAt: tokens.refreshTokenExpiresAt,
      });
    await this.d.vault.writeAccessToken(scope, {
      value: tokens.accessToken,
      expiresAt: tokens.accessTokenExpiresAt,
    });
    this.d.log.info('access token refreshed', {
      ...ids(scope),
      rotated: tokens.refreshToken !== null,
    });
    return tokens.accessToken;
  }

  async #reauth(scope: ConnectionScope, reason: ReauthReason): Promise<never> {
    const newlyFlagged = await this.d.directory.markReauthRequired(scope, reason);
    this.d.log.warn('connection requires reauthorization', { ...ids(scope), reason, newlyFlagged });
    throw new ConnectorError('auth_expired', reason, { reauthorize: true });
  }
}

const ids = (s: ConnectionScope) => ({
  organizationId: s.organizationId,
  brandId: s.brandId,
  connectionId: s.connectionId,
});
