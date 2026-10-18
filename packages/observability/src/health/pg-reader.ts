import type pg from 'pg';
import type { Platform } from '@feedbouncer/connectors';
import { boundedQuery } from '@feedbouncer/db';
import { deriveConnectionHealth, type ConnectionHealth, type HealthPolicy } from './derive.js';

export const HEALTH_SQL = `
  SELECT c.id, c.organization_id, c.brand_id, c.platform, c.status, c.status_reason,
         s.last_success_at, s.last_failure_at, s.last_error_code,
         COALESCE(s.consecutive_failures, 0) AS consecutive_failures,
         (SELECT min(j.created_at) FROM job_ledger j WHERE j.connection_id = c.id AND j.state = 'queued') AS oldest_queued_at,
         (SELECT count(*)::int FROM job_ledger j WHERE j.connection_id = c.id AND j.state = 'dead_lettered'
             AND j.job_type = 'comment_ingest' AND j.dead_lettered_at > now() - interval '14 days') AS failed_imports,
         a.expires_at AS access_expires_at, (a.id IS NOT NULL) AS has_access,
         r.expires_at AS refresh_expires_at, (r.id IS NOT NULL) AS has_refresh,
         now() AS db_now
    FROM connection c
    LEFT JOIN connection_sync s ON s.connection_id = c.id
    LEFT JOIN LATERAL (SELECT id, expires_at FROM connection_secret
                        WHERE connection_id = c.id AND kind = 'access_token' LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT id, expires_at FROM connection_secret
                        WHERE connection_id = c.id AND kind = 'refresh_token' LIMIT 1) r ON true`;

interface Rec {
  id: string;
  organization_id: string;
  brand_id: string;
  platform: Platform;
  status: 'active' | 'paused' | 'revoked' | 'error' | 'reconnect_required';
  status_reason: string | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_error_code: string | null;
  consecutive_failures: number;
  oldest_queued_at: Date | null;
  failed_imports: number;
  access_expires_at: Date | null;
  has_access: boolean;
  refresh_expires_at: Date | null;
  has_refresh: boolean;
  db_now: Date;
}

export interface HealthReader {
  forBrand(organizationId: string, brandId: string): Promise<ConnectionHealth[]>;
  all(limit: number): Promise<{ rows: ConnectionHealth[]; truncated: boolean }>;
}

export interface PgHealthReaderOptions {
  /** Server-side statement_timeout and overall bound for each query. Default 5000. */
  readonly timeoutMs?: number;
}

const FOR_BRAND_LIMIT = 500;

export class PgHealthReader implements HealthReader {
  readonly #timeoutMs: number;
  constructor(
    private readonly pool: pg.Pool,
    private readonly policy: HealthPolicy,
    opts: PgHealthReaderOptions = {},
  ) {
    this.#timeoutMs = opts.timeoutMs ?? 5_000;
  }

  #derive(r: Rec): ConnectionHealth {
    return deriveConnectionHealth(
      {
        connectionId: r.id,
        organizationId: r.organization_id,
        brandId: r.brand_id,
        platform: r.platform,
        status: r.status,
        statusReason: r.status_reason,
        lastSuccessAt: r.last_success_at,
        lastFailureAt: r.last_failure_at,
        lastErrorCode: r.last_error_code,
        consecutiveFailures: r.consecutive_failures,
        oldestQueuedAt: r.oldest_queued_at,
        accessTokenExpiresAt: r.access_expires_at,
        hasAccessToken: r.has_access,
        refreshTokenExpiresAt: r.refresh_expires_at,
        hasRefreshToken: r.has_refresh,
        failedImports: r.failed_imports,
      },
      this.policy,
      r.db_now,
    );
  }

  async forBrand(organizationId: string, brandId: string): Promise<ConnectionHealth[]> {
    const rows = await boundedQuery<Rec>(
      this.pool,
      `${HEALTH_SQL} WHERE c.organization_id = $1::uuid AND c.brand_id = $2::uuid ORDER BY c.created_at, c.id LIMIT ${FOR_BRAND_LIMIT}`,
      [organizationId, brandId],
      this.#timeoutMs,
    );
    return rows.map((r) => this.#derive(r));
  }

  async all(limit: number): Promise<{ rows: ConnectionHealth[]; truncated: boolean }> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('limit must be a positive integer');
    const rows = await boundedQuery<Rec>(
      this.pool,
      `${HEALTH_SQL} ORDER BY c.id LIMIT $1`,
      [limit + 1],
      this.#timeoutMs,
    );
    return {
      rows: rows.slice(0, limit).map((r) => this.#derive(r)),
      truncated: rows.length > limit,
    };
  }
}
