import type { Role } from '@feedbouncer/authz';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Secret } from '@feedbouncer/service-runtime';
import type { Platform } from './types.js';

export type ConnectionStatus = 'active' | 'paused' | 'revoked' | 'error' | 'reconnect_required';
export interface ConnectionRecord {
  readonly scope: ConnectionScope;
  readonly platform: Platform;
  readonly externalAccountId: string;
  readonly status: ConnectionStatus;
}
export type ReauthReason =
  | 'oauth_refresh_rejected'
  | 'oauth_access_rejected'
  | 'oauth_not_refreshable';
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
  activate(scope: ConnectionScope, actorUserId: string): Promise<void>;
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
