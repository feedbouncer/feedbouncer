// OAuth authorization-code flow with PKCE (S256). The state is 32 random
// bytes; only its SHA-256 is stored, bound to org, brand, platform and the
// initiating user, single-use (atomic delete-on-consume) and expiring. A
// mismatched session gets the same opaque 'rejected' and does NOT consume the
// victim's state. Authorization (membership + connection.manage) is checked
// here on both legs, so callers cannot forget it.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { can } from '@feedbouncer/authz';
import { Secret, type Logger } from '@feedbouncer/service-runtime';
import type { Clock } from './clock.js';
import type { Connector } from './connector.js';
import { toConnectorError } from './errors.js';
import { assertAllowedUrl, type SafeHttp } from './http.js';
import type {
  ConnectionDirectory,
  CredentialVault,
  MembershipReader,
  OAuthStateStore,
} from './ports.js';
import type { ConnectorRegistry } from './registry.js';
import { externalIdSchema } from './schemas.js';
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
  | { readonly ok: true; readonly connectionId: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly reason: 'rejected' | 'denied' | 'account_mismatch' | 'platform_error';
    };

export interface OAuthFlowDeps {
  registry: ConnectorRegistry;
  states: OAuthStateStore;
  memberships: MembershipReader;
  directory: ConnectionDirectory;
  vault: CredentialVault;
  clock: Clock;
  log: Logger;
  redirectUri(platform: Platform): string;
  http(connector: Connector): SafeHttp;
  stateTtlMs?: number;
  exchangeTimeoutMs?: number;
}

const REJECTED: OAuthCompletion = Object.freeze({ ok: false, reason: 'rejected' });

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

  async complete(
    actor: OAuthActor,
    platform: Platform,
    query: Readonly<Record<string, unknown>>,
  ): Promise<OAuthCompletion> {
    if (!(await this.#canManage(actor))) return REJECTED;
    const state = query.state;
    if (typeof state !== 'string' || !STATE_PATTERN.test(state)) return REJECTED;
    const pending = await this.d.states.consume(hashState(state), {
      organizationId: actor.organizationId,
      brandId: actor.brandId,
      platform,
      initiatedByUserId: actor.userId,
    });
    if (!pending || pending.expiresAt.getTime() <= this.d.clock.now()) return REJECTED;
    const ids = { organizationId: actor.organizationId, brandId: actor.brandId, platform };
    if (query.error !== undefined) {
      this.d.log.info('oauth authorization denied by user', ids);
      return { ok: false, reason: 'denied' };
    }
    const code = query.code;
    if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return REJECTED;

    const connector = this.d.registry.require(platform);
    let result;
    try {
      result = await connector.exchangeCode(
        { code: new Secret(code), codeVerifier: pending.codeVerifier },
        {
          http: this.d.http(connector),
          signal: AbortSignal.timeout(this.d.exchangeTimeoutMs ?? 15_000),
          redirectUri: pending.redirectUri,
        },
      );
    } catch (err) {
      const ce = toConnectorError(err);
      this.d.log.warn('oauth code exchange failed', { ...ids, kind: ce.kind, errorCode: ce.code });
      return { ok: false, reason: 'platform_error' };
    }
    const account = externalIdSchema.safeParse(result.account.externalAccountId);
    const displayName =
      typeof result.account.displayName === 'string'
        ? result.account.displayName.slice(0, 500)
        : null;
    if (!account.success) return { ok: false, reason: 'platform_error' };

    if (pending.reconnectConnectionId !== null) {
      const rec = await this.d.directory.load({
        organizationId: actor.organizationId,
        brandId: actor.brandId,
        connectionId: pending.reconnectConnectionId,
      });
      if (!rec || rec.externalAccountId !== account.data)
        return { ok: false, reason: 'account_mismatch' };
    }
    const { scope, created } = await this.d.directory.upsertPending({
      organizationId: actor.organizationId,
      brandId: actor.brandId,
      platform,
      externalAccountId: account.data,
      displayName,
      grantedScopes: result.tokens.scopes.slice(0, 100),
    });
    if (result.tokens.refreshToken)
      await this.d.vault.writeRefreshToken(scope, {
        value: result.tokens.refreshToken,
        expiresAt: result.tokens.refreshTokenExpiresAt,
      });
    await this.d.vault.writeAccessToken(scope, {
      value: result.tokens.accessToken,
      expiresAt: result.tokens.accessTokenExpiresAt,
    });
    await this.d.directory.activate(scope, actor.userId);
    this.d.log.info('connection authorized', { ...ids, connectionId: scope.connectionId, created });
    return { ok: true, connectionId: scope.connectionId, created };
  }
}
