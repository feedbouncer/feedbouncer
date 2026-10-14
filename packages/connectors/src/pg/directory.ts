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

/** One live (non-revoked) connection per platform account; a violation means another tenant owns it. */
const LIVE_ACCOUNT_INDEXES = [
  'connection_facebook_live_external_account_id_key',
  'connection_instagram_live_external_account_id_key',
];

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
      if (LIVE_ACCOUNT_INDEXES.some((index) => isUniqueViolation(err, index)))
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
    // Cross-tenant lookup (documented tenancy exception). Callers: webhook routing
    // after signature verification, and OAuth account listing/connect to detect a
    // Page already connected elsewhere. Returns at most one row by the live-page index.
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

  async findLiveByAccounts(
    platform: Platform,
    externalAccountIds: readonly string[],
  ): Promise<ReadonlyMap<string, ConnectionRecord>> {
    // Same cross-tenant exception as findLiveByAccount.
    const r = await this.pool.query<{
      id: string;
      organization_id: string;
      brand_id: string;
      status: ConnectionStatus;
      external_account_id: string;
    }>(
      `SELECT id, organization_id, brand_id, status, external_account_id FROM connection
        WHERE platform = $1 AND external_account_id = ANY($2::text[]) AND status <> 'revoked'`,
      [platform, externalAccountIds],
    );
    const perAccount = new Map<string, typeof r.rows>();
    for (const row of r.rows) {
      perAccount.set(row.external_account_id, [
        ...(perAccount.get(row.external_account_id) ?? []),
        row,
      ]);
    }
    const found = new Map<string, ConnectionRecord>();
    for (const [externalAccountId, rows] of perAccount) {
      if (rows.length !== 1) continue; // more than one live row: refuse to guess
      const row = rows[0]!;
      found.set(externalAccountId, {
        scope: { organizationId: row.organization_id, brandId: row.brand_id, connectionId: row.id },
        platform,
        externalAccountId,
        status: row.status,
      });
    }
    return found;
  }

  async disconnect(scope: ConnectionScope, actorUserId: string): Promise<boolean> {
    return withTransaction(this.pool, async (c) => {
      const r = await c.query<{ platform: string }>(
        `UPDATE connection SET status = 'revoked', status_reason = 'user_disconnected'
          WHERE id = $3 AND organization_id = $1 AND brand_id = $2
            AND (status <> 'revoked' OR status_reason IS DISTINCT FROM 'user_disconnected')
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
