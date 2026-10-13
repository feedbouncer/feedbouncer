// OAuth authorization-code flow with PKCE (S256). The state is 32 random
// bytes; only its SHA-256 is stored, bound to org, brand, platform and the
// initiating user, single-use (atomic delete-on-consume) and expiring. A
// mismatched session gets the same opaque 'rejected' and does NOT consume the
// victim's state. Authorization (membership + connection.manage) is checked
// here on both legs, so callers cannot forget it.
//
// Multi-account connectors (`accountSelection: 'multiple'`) do not connect on
// the callback: the user token is sealed into a short-lived, single-use grant
// bound like the state, and the user then picks accounts. Each account's own
// token is fetched again on connect; the user token never leaves the grant.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { can } from '@feedbouncer/authz';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { Secret, type Logger } from '@feedbouncer/service-runtime';
import { z } from 'zod';
import type { Clock } from './clock.js';
import type { AuthorizedAccount, Connector, GrantableAccount, TokenSet } from './connector.js';
import { ConnectorError, toConnectorError } from './errors.js';
import { assertAllowedUrl, type SafeHttp } from './http.js';
import {
  ConnectionTakenError,
  type ConnectionDirectory,
  type CredentialVault,
  type MembershipReader,
  type OAuthGrantStore,
  type OAuthStateStore,
  type StateBinding,
} from './ports.js';
import type { ConnectorRegistry } from './registry.js';
import { externalIdSchema, grantableAccountSchema } from './schemas.js';
import { normalizeTokenSet } from './tokens.js';
import type { Platform } from './types.js';

export const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[\x21-\x7e]{1,2048}$/;

export function newPkcePair(): { verifier: Secret; challenge: string } {
  const v = randomBytes(32).toString('base64url');
  return { verifier: new Secret(v), challenge: createHash('sha256').update(v).digest('base64url') };
}
export const hashState = (state: string): Buffer =>
  createHash('sha256').update(state, 'utf8').digest();

export class OAuthAccessDeniedError extends Error {
  override name = 'OAuthAccessDeniedError';
  constructor() {
    super('Not allowed to manage connections for this brand.');
  }
}

export interface OAuthActor {
  readonly userId: string;
  readonly organizationId: string;
  readonly brandId: string;
}
export type OAuthCompletion =
  | {
      readonly ok: true;
      readonly kind: 'connected';
      readonly connectionId: string;
      readonly created: boolean;
    }
  /** Multi-account connector: the user picks accounts from this grant next. */
  | { readonly ok: true; readonly kind: 'account_selection'; readonly grantId: string }
  /** Values are a subset of the connector's own `requiredScopes`, never platform text. */
  | {
      readonly ok: false;
      readonly reason: 'missing_permissions';
      readonly missing: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'rejected'
        | 'denied'
        | 'account_mismatch'
        | 'platform_error'
        /**
         * The connection is revoked (terminal) or paused, so no tokens were stored;
         * or activation itself was refused (tokens written, connection not active).
         */
        | 'connection_inactive';
    };

export interface GrantAccountView {
  readonly externalAccountId: string;
  readonly displayName: string | null;
  readonly eligible: boolean;
  readonly ineligibleReason: string | null;
  readonly limitations: readonly string[];
  /** Whether the account already has a live connection, here or in another workspace. */
  readonly connection: 'this_brand' | 'elsewhere' | null;
}
export type ConnectAccountStatus =
  | 'connected'
  | 'reconnected'
  | 'not_eligible'
  | 'not_found'
  | 'connected_elsewhere'
  | 'connection_inactive';
export interface ConnectAccountResult {
  readonly externalAccountId: string;
  readonly status: ConnectAccountStatus;
  readonly connectionId: string | null;
  readonly wasReconnectRequired: boolean;
}
export type GrantFailure = { readonly ok: false; readonly reason: 'rejected' | 'platform_error' };

const MAX_CONNECT_IDS = 50;
const MAX_GRANTABLE_ACCOUNTS = 500;
const grantableAccountsSchema = z.array(grantableAccountSchema).max(MAX_GRANTABLE_ACCOUNTS);

export interface OAuthFlowDeps {
  registry: ConnectorRegistry;
  states: OAuthStateStore;
  memberships: MembershipReader;
  directory: ConnectionDirectory;
  vault: CredentialVault;
  /** Required for multi-account connectors. */
  grants?: OAuthGrantStore;
  clock: Clock;
  log: Logger;
  redirectUri(platform: Platform): string;
  http(connector: Connector): SafeHttp;
  stateTtlMs?: number;
  exchangeTimeoutMs?: number;
  /** Lifetime of a multi-account grant. Default 30 minutes. */
  grantTtlMs?: number;
}

const REJECTED: OAuthCompletion = Object.freeze({ ok: false, reason: 'rejected' });
const GRANT_REJECTED: GrantFailure = Object.freeze({ ok: false, reason: 'rejected' });
const GRANT_PLATFORM_ERROR: GrantFailure = Object.freeze({ ok: false, reason: 'platform_error' });
const result = (
  externalAccountId: string,
  status: ConnectAccountStatus,
  connectionId: string | null = null,
  wasReconnectRequired = false,
): ConnectAccountResult => ({ externalAccountId, status, connectionId, wasReconnectRequired });

export class OAuthFlow {
  constructor(private readonly d: OAuthFlowDeps) {}

  async #canManage(a: OAuthActor): Promise<boolean> {
    const role = await this.d.memberships.roleInBrand(a.organizationId, a.brandId, a.userId);
    return role !== null && can(role, 'connection.manage');
  }

  async start(
    actor: OAuthActor,
    platform: Platform,
    opts: { reconnectConnectionId?: string } = {},
  ): Promise<{ authorizationUrl: URL }> {
    if (!(await this.#canManage(actor))) throw new OAuthAccessDeniedError();
    const connector = this.d.registry.require(platform);
    const reconnect = opts.reconnectConnectionId ?? null;
    if (reconnect !== null) {
      const rec = await this.d.directory.load({
        organizationId: actor.organizationId,
        brandId: actor.brandId,
        connectionId: reconnect,
      });
      if (!rec || rec.platform !== platform) throw new OAuthAccessDeniedError();
    }
    const state = randomBytes(32).toString('base64url');
    const { verifier, challenge } = newPkcePair();
    const redirectUri = this.d.redirectUri(platform);
    const scopes = connector.capabilities.defaultScopes;
    const url = assertAllowedUrl(
      connector.buildAuthorizationUrl({ state, codeChallenge: challenge, redirectUri, scopes }),
      connector.capabilities.authorizationHosts,
    );
    if (url.searchParams.get('state') !== state)
      throw new TypeError('Connector authorization URL must carry the state');
    await this.d.states.save(hashState(state), {
      id: randomUUID(),
      organizationId: actor.organizationId,
      brandId: actor.brandId,
      platform,
      initiatedByUserId: actor.userId,
      redirectUri,
      scopes,
      reconnectConnectionId: reconnect,
      codeVerifier: verifier,
      expiresAt: new Date(this.d.clock.now() + (this.d.stateTtlMs ?? 600_000)),
    });
    return { authorizationUrl: url };
  }

  #inactive(
    ids: { organizationId: string; brandId: string; platform: Platform },
    connectionId: string,
  ): OAuthCompletion {
    this.d.log.warn('oauth completion refused: connection is not activatable', {
      ...ids,
      connectionId,
    });
    return { ok: false, reason: 'connection_inactive' };
  }

  async complete(
    actor: OAuthActor,
    platform: Platform,
    query: Readonly<Record<string, unknown>>,
  ): Promise<OAuthCompletion> {
    if (!(await this.#canManage(actor))) return REJECTED;
    const state = query.state;
    if (typeof state !== 'string' || !STATE_PATTERN.test(state)) return REJECTED;
    const code =
      typeof query.code === 'string' && CODE_PATTERN.test(query.code) ? query.code : null;
    // Checked before consume, so a malformed code cannot burn the pending state.
    if (query.error === undefined && code === null) return REJECTED;
    const pending = await this.d.states.consume(hashState(state), {
      organizationId: actor.organizationId,
      brandId: actor.brandId,
      platform,
      initiatedByUserId: actor.userId,
    });
    if (!pending || pending.expiresAt.getTime() <= this.d.clock.now()) return REJECTED;
    const ids = { organizationId: actor.organizationId, brandId: actor.brandId, platform };
    // code is null here only when the provider reported an error
    if (query.error !== undefined || code === null) {
      this.d.log.info('oauth authorization denied by user', ids);
      return { ok: false, reason: 'denied' };
    }

    const connector = this.d.registry.require(platform);
    let tokens: TokenSet;
    let authorized: AuthorizedAccount;
    try {
      const result = await connector.exchangeCode(
        { code: new Secret(code), codeVerifier: pending.codeVerifier },
        {
          http: this.d.http(connector),
          signal: AbortSignal.timeout(this.d.exchangeTimeoutMs ?? 15_000),
          redirectUri: pending.redirectUri,
        },
      );
      tokens = normalizeTokenSet(result.tokens, this.d.log, ids);
      authorized = result.account;
    } catch (err) {
      const ce = toConnectorError(err);
      this.d.log.warn('oauth code exchange failed', { ...ids, kind: ce.kind, errorCode: ce.code });
      return { ok: false, reason: 'platform_error' };
    }

    const required = connector.capabilities.requiredScopes ?? [];
    const missing = required.filter((s) => !tokens.scopes.includes(s));
    if (missing.length > 0) {
      this.d.log.info('oauth completed without required permissions', {
        ...ids,
        missingCount: missing.length,
      });
      return { ok: false, reason: 'missing_permissions', missing };
    }
    if ((connector.capabilities.accountSelection ?? 'single') === 'multiple') {
      if (!this.d.grants)
        throw new TypeError('OAuthFlow needs a grant store for multi-account connectors');
      const grantId = randomUUID();
      await this.d.grants.save({
        id: grantId,
        organizationId: actor.organizationId,
        brandId: actor.brandId,
        platform,
        initiatedByUserId: actor.userId,
        reconnectConnectionId: pending.reconnectConnectionId,
        userToken: tokens.accessToken,
        grantedScopes: tokens.scopes,
        expiresAt: new Date(this.d.clock.now() + (this.d.grantTtlMs ?? 1_800_000)),
      });
      this.d.log.info('oauth grant awaiting account selection', ids);
      return { ok: true, kind: 'account_selection', grantId };
    }

    const account = externalIdSchema.safeParse(authorized?.externalAccountId);
    const displayName =
      typeof authorized?.displayName === 'string' ? authorized.displayName.slice(0, 500) : null;
    if (!account.success) return { ok: false, reason: 'platform_error' };

    if (pending.reconnectConnectionId !== null) {
      const rec = await this.d.directory.load({
        organizationId: actor.organizationId,
        brandId: actor.brandId,
        connectionId: pending.reconnectConnectionId,
      });
      if (!rec || rec.externalAccountId !== account.data)
        return { ok: false, reason: 'account_mismatch' };
      if (rec.status === 'revoked') return this.#inactive(ids, pending.reconnectConnectionId);
    }
    const { scope, created } = await this.d.directory.upsertPending({
      organizationId: actor.organizationId,
      brandId: actor.brandId,
      platform,
      externalAccountId: account.data,
      displayName,
      grantedScopes: tokens.scopes,
    });
    // activate() refuses revoked (terminal) and paused rows: check first, so no tokens are stored.
    const status = (await this.d.directory.load(scope))?.status;
    if (status === 'revoked' || status === 'paused') return this.#inactive(ids, scope.connectionId);
    if (tokens.refreshToken)
      await this.d.vault.writeRefreshToken(scope, {
        value: tokens.refreshToken,
        expiresAt: tokens.refreshTokenExpiresAt,
      });
    await this.d.vault.writeAccessToken(scope, {
      value: tokens.accessToken,
      expiresAt: tokens.accessTokenExpiresAt,
    });
    if (!(await this.d.directory.activate(scope, actor.userId)))
      return this.#inactive(ids, scope.connectionId);
    this.d.log.info('connection authorized', { ...ids, connectionId: scope.connectionId, created });
    return { ok: true, kind: 'connected', connectionId: scope.connectionId, created };
  }

  /**
   * OAuth callback where only the session user is known. The org/brand come
   * from the stored state binding (pre-auth peek, ids only); `complete` then
   * re-checks membership and consumes atomically with the full binding.
   * Unknown, expired, another user's or another platform's state all get the
   * same opaque result, and nothing is consumed.
   */
  async completeForUser(
    userId: string,
    platform: Platform,
    query: Readonly<Record<string, unknown>>,
  ): Promise<{ actor: OAuthActor | null; completion: OAuthCompletion }> {
    const state = query.state;
    if (typeof state !== 'string' || !STATE_PATTERN.test(state))
      return { actor: null, completion: REJECTED };
    const b = await this.d.states.peekBinding(hashState(state));
    if (!b || b.platform !== platform || b.initiatedByUserId !== userId)
      return { actor: null, completion: REJECTED };
    const actor: OAuthActor = { userId, organizationId: b.organizationId, brandId: b.brandId };
    return { actor, completion: await this.complete(actor, platform, query) };
  }

  #binding(a: OAuthActor, platform: Platform): StateBinding {
    return {
      organizationId: a.organizationId,
      brandId: a.brandId,
      platform,
      initiatedByUserId: a.userId,
    };
  }

  /** Lists the accounts a user token covers; null (logged, no platform text) on any failure. */
  async #accounts(
    platform: Platform,
    userToken: Secret,
  ): Promise<readonly GrantableAccount[] | null> {
    try {
      const connector = this.d.registry.require(platform);
      if (!connector.listAccounts)
        throw new ConnectorError('unsupported', 'account_selection_unsupported');
      const raw = await connector.listAccounts(userToken, {
        http: this.d.http(connector),
        signal: AbortSignal.timeout(this.d.exchangeTimeoutMs ?? 15_000),
        redirectUri: this.d.redirectUri(platform),
      });
      const parsed = grantableAccountsSchema.safeParse(raw);
      if (!parsed.success) throw new ConnectorError('permanent', 'invalid_connector_output');
      return parsed.data;
    } catch (err) {
      const ce = toConnectorError(err);
      this.d.log.warn('oauth account listing failed', {
        platform,
        kind: ce.kind,
        errorCode: ce.code,
      });
      return null;
    }
  }

  /** Accounts of a pending grant, without tokens. Does not consume the grant. */
  async listGrantAccounts(
    actor: OAuthActor,
    platform: Platform,
    grantId: string,
  ): Promise<{ ok: true; accounts: readonly GrantAccountView[] } | GrantFailure> {
    if (!this.d.grants || !(await this.#canManage(actor))) return GRANT_REJECTED;
    const grant = await this.d.grants.load(grantId, this.#binding(actor, platform));
    if (!grant) return GRANT_REJECTED;
    const accounts = await this.#accounts(platform, grant.userToken);
    if (!accounts) return GRANT_PLATFORM_ERROR;
    const views: GrantAccountView[] = [];
    for (const a of accounts) {
      const live = await this.d.directory.findLiveByAccount(platform, a.externalAccountId);
      const connection = !live
        ? null
        : live.scope.organizationId === actor.organizationId && live.scope.brandId === actor.brandId
          ? 'this_brand'
          : 'elsewhere';
      views.push({
        externalAccountId: a.externalAccountId,
        displayName: a.displayName,
        eligible: a.eligible,
        ineligibleReason: a.ineligibleReason,
        limitations: a.limitations,
        connection,
      });
    }
    return { ok: true, accounts: views };
  }

  /**
   * Connects the chosen accounts with their own tokens. Consumes the grant
   * (single-use) once the request is well-formed and authorized.
   */
  async connectAccounts(
    actor: OAuthActor,
    platform: Platform,
    grantId: string,
    externalAccountIds: readonly string[],
  ): Promise<{ ok: true; results: readonly ConnectAccountResult[] } | GrantFailure> {
    if (!this.d.grants || !(await this.#canManage(actor))) return GRANT_REJECTED;
    if (
      externalAccountIds.length < 1 ||
      externalAccountIds.length > MAX_CONNECT_IDS ||
      !externalAccountIds.every((i) => externalIdSchema.safeParse(i).success)
    )
      return GRANT_REJECTED;
    const grant = await this.d.grants.consume(grantId, this.#binding(actor, platform));
    if (!grant) return GRANT_REJECTED;
    const accounts = await this.#accounts(platform, grant.userToken);
    if (!accounts) return GRANT_PLATFORM_ERROR;
    const byId = new Map(accounts.map((a) => [a.externalAccountId, a]));
    const results: ConnectAccountResult[] = [];
    for (const id of new Set(externalAccountIds)) {
      const a = byId.get(id);
      if (!a) {
        results.push(result(id, 'not_found'));
        continue;
      }
      if (!a.eligible) {
        results.push(result(id, 'not_eligible'));
        continue;
      }
      if (grant.reconnectConnectionId !== null) {
        const rec = await this.d.directory.load({
          organizationId: actor.organizationId,
          brandId: actor.brandId,
          connectionId: grant.reconnectConnectionId,
        });
        if (!rec || rec.externalAccountId !== id) {
          results.push(result(id, 'not_found'));
          continue;
        }
      }
      results.push(await this.#connectOne(actor, platform, grant.grantedScopes, a));
    }
    this.d.log.info('oauth accounts connected', {
      platform,
      organizationId: actor.organizationId,
      brandId: actor.brandId,
      connected: results.filter((r) => r.status === 'connected' || r.status === 'reconnected')
        .length,
    });
    return { ok: true, results };
  }

  async #connectOne(
    actor: OAuthActor,
    platform: Platform,
    grantedScopes: readonly string[],
    a: GrantableAccount,
  ): Promise<ConnectAccountResult> {
    const id = a.externalAccountId;
    // Whether a live row existed before: if not, the row upsertPending leaves
    // live (new, or revived from a user disconnect) is ours to undo on failure.
    const prior = await this.d.directory.findLiveByAccount(platform, id);
    let upserted: { scope: ConnectionScope; created: boolean };
    try {
      upserted = await this.d.directory.upsertPending({
        organizationId: actor.organizationId,
        brandId: actor.brandId,
        platform,
        externalAccountId: id,
        displayName: a.displayName?.slice(0, 500) ?? null,
        grantedScopes,
      });
    } catch (err) {
      if (err instanceof ConnectionTakenError) return result(id, 'connected_elsewhere');
      throw err;
    }
    const { scope, created } = upserted;
    const before = await this.d.directory.load(scope);
    if (before?.status === 'revoked' || before?.status === 'paused')
      return result(id, 'connection_inactive', scope.connectionId);
    const freshlyLive = created || prior === null;
    let activated = false;
    try {
      await this.d.vault.writeAccessToken(scope, { value: a.accessToken, expiresAt: null });
      activated = await this.d.directory.activate(scope, actor.userId);
    } finally {
      // A pending row that never became active must not keep holding the
      // account against other workspaces (or route its webhooks).
      if (!activated && freshlyLive) await this.#release(scope, actor, platform);
    }
    if (!activated) return result(id, 'connection_inactive', scope.connectionId);
    return result(id, created ? 'connected' : 'reconnected', scope.connectionId, !created);
  }

  async #release(scope: ConnectionScope, actor: OAuthActor, platform: Platform): Promise<void> {
    const ids = {
      platform,
      organizationId: scope.organizationId,
      brandId: scope.brandId,
      connectionId: scope.connectionId,
    };
    try {
      await this.d.directory.disconnect(scope, actor.userId);
      this.d.log.warn('oauth account connect failed; pending connection released', ids);
    } catch (err) {
      // Never mask the original failure; the row stays pending and is reported.
      this.d.log.error('oauth pending connection could not be released', {
        ...ids,
        errorName: err instanceof Error ? err.name : 'NonError',
      });
    }
  }
}
