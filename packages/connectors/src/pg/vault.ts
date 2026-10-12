import {
  CredentialUnreadableError,
  markReconnectRequired,
  type ConnectionScope,
  type CredentialStore,
  type Queryable,
} from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import { ConnectorError } from '../errors.js';
import type { CredentialVault, TokenRecord } from '../ports.js';

/**
 * Each write is its own committed statement on purpose: the refresh token is
 * durable before the access token is attempted (token rotation safety).
 */
export class PgCredentialVault implements CredentialVault {
  constructor(
    private readonly store: CredentialStore,
    private readonly db: Queryable,
    private readonly log: Logger,
  ) {}

  async readTokens(
    scope: ConnectionScope,
  ): Promise<{ access: TokenRecord | null; refresh: TokenRecord | null }> {
    try {
      return await this.store.withCredentials(
        scope,
        ['access_token', 'refresh_token'],
        async (m) => {
          const pick = (k: 'access_token' | 'refresh_token') => {
            const c = m.get(k);
            return c ? { value: c.value, expiresAt: c.expiresAt } : null;
          };
          return { access: pick('access_token'), refresh: pick('refresh_token') };
        },
      );
    } catch (err) {
      if (!(err instanceof CredentialUnreadableError)) throw err;
      const newlyFlagged = await markReconnectRequired(this.db, scope, err);
      this.log.warn('connection credentials unreadable; connection marked for reconnect', {
        organizationId: scope.organizationId,
        brandId: scope.brandId,
        connectionId: scope.connectionId,
        reason: err.reason,
        keyId: err.keyId,
        newlyFlagged,
      });
      throw new ConnectorError('auth_expired', 'credential_unreadable', { reauthorize: true });
    }
  }

  writeRefreshToken(scope: ConnectionScope, t: TokenRecord): Promise<void> {
    return this.store.put(scope, 'refresh_token', t.value, t.expiresAt);
  }

  writeAccessToken(scope: ConnectionScope, t: TokenRecord): Promise<void> {
    return this.store.put(scope, 'access_token', t.value, t.expiresAt);
  }
}
