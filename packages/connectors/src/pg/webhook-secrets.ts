import type pg from 'pg';
import type { CredentialStore } from '@feedbouncer/secrets';
import type { Secret } from '@feedbouncer/service-runtime';
import type { WebhookSecretSource } from '../ports.js';
import type { Platform } from '../types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Pre-authentication lookup (documented exception to scope filtering): the
// connection id comes from the webhook URL; the HMAC check that follows is what
// authenticates the request. Requires platform match and status 'active'.
export class PgWebhookSecrets implements WebhookSecretSource {
  constructor(
    private readonly pool: pg.Pool,
    private readonly store: CredentialStore,
    private readonly app: ReadonlyMap<Platform, Secret>,
  ) {}

  appSecret(platform: Platform): Secret | null {
    return this.app.get(platform) ?? null;
  }

  async connectionSecret(
    connectionId: string,
    platform: Platform,
  ): Promise<{ secret: Secret; externalAccountId: string } | null> {
    if (!UUID.test(connectionId)) return null;
    const r = await this.pool.query<{
      organization_id: string;
      brand_id: string;
      external_account_id: string;
    }>(
      `SELECT organization_id, brand_id, external_account_id FROM connection
        WHERE id = $1 AND platform = $2 AND status = 'active'`,
      [connectionId, platform],
    );
    const row = r.rows[0];
    if (!row) return null;
    const cred = await this.store
      .get(
        { organizationId: row.organization_id, brandId: row.brand_id, connectionId },
        'webhook_secret',
      )
      .catch(() => null); // unreadable credential: same opaque outcome as no secret
    return cred ? { secret: cred.value, externalAccountId: row.external_account_id } : null;
  }
}
