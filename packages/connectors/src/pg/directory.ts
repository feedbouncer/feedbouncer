import type pg from 'pg';
import { isUniqueViolation, withTransaction } from '@feedbouncer/db';
import { flagReconnectRequired, type ConnectionScope } from '@feedbouncer/secrets';
import {
  ConnectionTakenError,
  type ConnectionDirectory,
  type ConnectionRecord,
  type ConnectionStatus,
  type ReauthReason,
} from '../ports.js';
import type { Platform } from '../types.js';
import { noNul } from './sanitize.js';

export class PgConnectionDirectory implements ConnectionDirectory {
  constructor(private readonly pool: pg.Pool) {}

  async load(scope: ConnectionScope): Promise<ConnectionRecord | null> {
    const r = await this.pool.query<{
      platform: Platform;
      external_account_id: string;
      status: ConnectionStatus;
    }>(
      `SELECT platform, external_account_id, status FROM connection
        WHERE id = $3 AND organization_id = $1 AND brand_id = $2`,
      [scope.organizationId, scope.brandId, scope.connectionId],
    );
    const row = r.rows[0];
    return row
      ? {
          scope,
          platform: row.platform,
          externalAccountId: row.external_account_id,
          status: row.status,
        }
      : null;
  }

  markReauthRequired(scope: ConnectionScope, reason: ReauthReason): Promise<boolean> {
    return flagReconnectRequired(this.pool, scope, reason, { reason });
  }

  async upsertPending(i: {
    organizationId: string;
    brandId: string;
    platform: Platform;
    externalAccountId: string;
    displayName: string | null;
    grantedScopes: readonly string[];
  }): Promise<{ scope: ConnectionScope; created: boolean }> {
    let r;
    try {
      r = await this.pool.query<{ id: string; created: boolean }>(
        `INSERT INTO connection (organization_id, brand_id, platform, external_account_id, display_name, granted_scopes, status, status_reason)
         VALUES ($1, $2, $3, $4, $5, $6::text[], 'reconnect_required', 'oauth_pending')
         ON CONFLICT (brand_id, platform, external_account_id) DO UPDATE
            SET status = CASE WHEN connection.status = 'revoked' AND connection.status_reason = 'user_disconnected'
                              THEN 'reconnect_required' ELSE connection.status END,
                status_reason = CASE WHEN connection.status = 'revoked' AND connection.status_reason = 'user_disconnected'
                                     THEN 'oauth_pending' ELSE connection.status_reason END,
                display_name = CASE WHEN connection.status = 'paused'
                                      OR (connection.status = 'revoked' AND connection.status_reason IS DISTINCT FROM 'user_disconnected')
                                    THEN connection.display_name ELSE EXCLUDED.display_name END,
                granted_scopes = CASE WHEN connection.status = 'paused'
                                        OR (connection.status = 'revoked' AND connection.status_reason IS DISTINCT FROM 'user_disconnected')
                                      THEN connection.granted_scopes ELSE EXCLUDED.granted_scopes END
          WHERE connection.organization_id = EXCLUDED.organization_id
         RETURNING id, (xmax = 0) AS created`,
        [
          i.organizationId,
          i.brandId,
          i.platform,
          i.externalAccountId,
          i.displayName === null ? null : noNul(i.displayName),
          i.grantedScopes.map(noNul),
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err, 'connection_facebook_live_external_account_id_key'))
        throw new ConnectionTakenError();
      throw err;
    }
    const row = r.rows[0];
    if (!row) throw new Error('Connection upsert affected no row (tenant mismatch)');
    return {
      scope: { organizationId: i.organizationId, brandId: i.brandId, connectionId: row.id },
      created: row.created,
    };
  }

  /** Only pending, errored or already-active connections activate; paused and revoked ones never do. */
  async activate(scope: ConnectionScope, actorUserId: string): Promise<boolean> {
    return withTransaction(this.pool, async (c) => {
      const r = await c.query<{ platform: string }>(
        `UPDATE connection SET status = 'active', status_reason = NULL
          WHERE id = $3 AND organization_id = $1 AND brand_id = $2
            AND status IN ('active', 'reconnect_required', 'error')
        RETURNING platform`,
        [scope.organizationId, scope.brandId, scope.connectionId],
      );
      if (r.rowCount !== 1) return false;
      await c.query(
        `INSERT INTO audit_event (organization_id, brand_id, actor_type, actor_user_id, action, subject_type, subject_id, details)
         VALUES ($1, $2, 'user', $4, 'connection.authorized', 'connection', $3, jsonb_build_object('platform', $5::text))`,
        [scope.organizationId, scope.brandId, scope.connectionId, actorUserId, r.rows[0]!.platform],
      );
      return true;
    });
  }

  async findLiveByAccount(
    platform: Platform,
    externalAccountId: string,
  ): Promise<ConnectionRecord | null> {
    // Pre-authentication lookup (documented tenancy exception): runs only after the
    // webhook signature verified, and returns at most one row by the live-page index.
    const r = await this.pool.query<{
      id: string;
      organization_id: string;
      brand_id: string;
      status: ConnectionStatus;
    }>(
      `SELECT id, organization_id, brand_id, status FROM connection
        WHERE platform = $1 AND external_account_id = $2 AND status <> 'revoked'
        ORDER BY created_at LIMIT 2`,
      [platform, externalAccountId],
    );
    if (r.rows.length !== 1) return null; // 0, or >1 for platforms without the live index: refuse to guess
    const row = r.rows[0]!;
    return {
      scope: { organizationId: row.organization_id, brandId: row.brand_id, connectionId: row.id },
      platform,
      externalAccountId,
      status: row.status,
    };
  }

  async disconnect(scope: ConnectionScope, actorUserId: string): Promise<boolean> {
    return withTransaction(this.pool, async (c) => {
      const r = await c.query<{ platform: string }>(
        `UPDATE connection SET status = 'revoked', status_reason = 'user_disconnected'
          WHERE id = $3 AND organization_id = $1 AND brand_id = $2 AND status <> 'revoked'
        RETURNING platform`,
        [scope.organizationId, scope.brandId, scope.connectionId],
      );
      if (r.rowCount !== 1) return false;
      await c.query(
        `INSERT INTO audit_event (organization_id, brand_id, actor_type, actor_user_id, action, subject_type, subject_id, details)
         VALUES ($1, $2, 'user', $4, 'connection.disconnected', 'connection', $3, jsonb_build_object('platform', $5::text))`,
        [scope.organizationId, scope.brandId, scope.connectionId, actorUserId, r.rows[0]!.platform],
      );
      return true;
    });
  }
}
