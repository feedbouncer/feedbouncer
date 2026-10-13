import type { Role } from '@feedbouncer/authz';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { ErrorClass, Logger, Secret } from '@feedbouncer/service-runtime';
import type { Platform } from './types.js';

export type ConnectionStatus = 'active' | 'paused' | 'revoked' | 'error' | 'reconnect_required';
export interface ConnectionRecord {
  readonly scope: ConnectionScope;
  readonly platform: Platform;
  readonly externalAccountId: string;
  readonly status: ConnectionStatus;
}
export const REAUTH_REASONS = [
  'oauth_refresh_rejected',
  'oauth_access_rejected',
  'oauth_not_refreshable',
] as const;
export type ReauthReason = (typeof REAUTH_REASONS)[number];
export interface ConnectionDirectory {
  load(scope: ConnectionScope): Promise<ConnectionRecord | null>;
  markReauthRequired(scope: ConnectionScope, reason: ReauthReason): Promise<boolean>;
  upsertPending(input: {
    organizationId: string;
    brandId: string;
    platform: Platform;
    externalAccountId: string;
    displayName: string | null;
    grantedScopes: readonly string[];
  }): Promise<{ scope: ConnectionScope; created: boolean }>;
  /**
   * Moves a pending, errored or already-active connection to active. Paused and
   * revoked connections never activate: `revoked` is terminal for the framework.
   * Resolves true only when the row ended up active.
   */
  activate(scope: ConnectionScope, actorUserId: string): Promise<boolean>;
  /**
   * Pre-authentication lookup (documented tenancy exception), used only after a
   * webhook signature verified: the single non-revoked connection for an account.
   */
  findLiveByAccount(
    platform: Platform,
    externalAccountId: string,
  ): Promise<ConnectionRecord | null>;
  /** Marks revoked/user_disconnected and audits; false if already revoked or not in scope. */
  disconnect(scope: ConnectionScope, actorUserId: string): Promise<boolean>;
}
/** Thrown by `upsertPending` when the account is already live in another workspace. */
export class ConnectionTakenError extends Error {
  override name = 'ConnectionTakenError';
  readonly code = 'connected_elsewhere';
  constructor() {
    super('This account is already connected in another workspace.');
  }
}
export interface TokenRecord {
  readonly value: Secret;
  readonly expiresAt: Date | null;
}
export interface CredentialVault {
  readTokens(
    scope: ConnectionScope,
  ): Promise<{ access: TokenRecord | null; refresh: TokenRecord | null }>;
  writeRefreshToken(scope: ConnectionScope, t: TokenRecord): Promise<void>;
  writeAccessToken(scope: ConnectionScope, t: TokenRecord): Promise<void>;
  /** Removes every stored credential of the connection (teardown). Idempotent. */
  deleteTokens(scope: ConnectionScope): Promise<void>;
}
export interface RefreshLock {
  run<T>(scope: ConnectionScope, fn: () => Promise<T>): Promise<T>;
}
export interface PendingAuthorization {
  readonly id: string;
  readonly organizationId: string;
  readonly brandId: string;
  readonly platform: Platform;
  readonly initiatedByUserId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly reconnectConnectionId: string | null;
  readonly codeVerifier: Secret;
  readonly expiresAt: Date;
}
export interface StateBinding {
  readonly organizationId: string;
  readonly brandId: string;
  readonly platform: Platform;
  readonly initiatedByUserId: string;
}
export interface OAuthStateStore {
  save(stateHash: Buffer, p: PendingAuthorization): Promise<void>;
  /** Atomically deletes and returns the row iff hash AND binding match; otherwise null and nothing is deleted. */
  consume(stateHash: Buffer, binding: StateBinding): Promise<PendingAuthorization | null>;
  /** Pre-auth read of who started this flow; never returns secrets; expired rows return null. */
  peekBinding(stateHash: Buffer): Promise<StateBinding | null>;
}
export interface PendingGrant {
  readonly id: string;
  readonly organizationId: string;
  readonly brandId: string;
  readonly platform: Platform;
  readonly initiatedByUserId: string;
  readonly reconnectConnectionId: string | null;
  readonly userToken: Secret;
  readonly grantedScopes: readonly string[];
  readonly expiresAt: Date;
}
export interface OAuthGrantStore {
  save(g: PendingGrant): Promise<void>;
  /** Binding mismatch or expiry returns null without consuming. */
  load(id: string, binding: StateBinding): Promise<PendingGrant | null>;
  /** Atomic delete-returning; binding mismatch consumes nothing. */
  consume(id: string, binding: StateBinding): Promise<PendingGrant | null>;
}
export interface MembershipReader {
  roleInBrand(organizationId: string, brandId: string, userId: string): Promise<Role | null>;
}
export interface DeliveryLedger {
  once(
    namespace: string,
    key: string,
    work: () => Promise<void>,
  ): Promise<'processed' | 'duplicate'>;
}
export interface WebhookSecretSource {
  appSecret(platform: Platform): Secret | null;
  connectionSecret(
    connectionId: string,
    platform: Platform,
  ): Promise<{ secret: Secret; externalAccountId: string } | null>;
}

/**
 * Records per-connection sync health. Implementations may throw or reject;
 * callers treat the recorder as best-effort telemetry and never fail work on it.
 */
export interface SyncRecorder {
  success(connectionId: string): Promise<void>;
  failure(
    connectionId: string,
    f: { readonly code: string; readonly errorClass: ErrorClass },
  ): Promise<void>;
}
export const noopSyncRecorder: SyncRecorder = { success: async () => {}, failure: async () => {} };

/**
 * Fire-and-forget: a slow or failing recorder never delays or fails the caller.
 * Shared by the connector runtime and the webhook gate.
 */
export function recordSync(
  sync: SyncRecorder | undefined,
  log: Logger,
  ids: { readonly platform: string; readonly connectionId: string },
  f: (s: SyncRecorder) => Promise<void>,
): void {
  if (!sync) return;
  const warn = (err: unknown) =>
    log.warn('telemetry.sync_record_failed', {
      ...ids,
      errorName: err instanceof Error ? err.name : 'NonError',
    });
  try {
    void f(sync).catch(warn);
  } catch (err) {
    warn(err);
  }
}
