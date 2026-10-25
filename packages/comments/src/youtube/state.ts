// Poll and dispatch cycle state of YouTube connections: one youtube_connection_state
// row per connection. A cycle holds the row's lease while it runs, so two replicas
// never run one connection's cycle at once. Every statement is filtered by
// organization_id + brand_id + connection_id, except `dueConnections`, which
// returns ids only to the trusted scheduler.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { CYCLE_LEASE_MS } from './dispatch.js';

export interface YouTubeCycleState {
  nextReadAt: Date;
  nextDispatchAt: Date | null;
  highWaterAt: Date | null;
  resumePageToken: string | null;
  lastReadUnits: number;
}

export type YouTubeStatePatch = Partial<
  YouTubeCycleState & { lastErrorCode: string | null }
>;

const COLUMNS = {
  nextReadAt: 'next_read_at',
  nextDispatchAt: 'next_dispatch_at',
  highWaterAt: 'high_water_at',
  resumePageToken: 'resume_page_token',
  lastReadUnits: 'last_read_units',
  lastErrorCode: 'last_error_code',
} as const satisfies Record<keyof YouTubeStatePatch, string>;

const scopeParams = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];

interface Row {
  next_read_at: Date;
  next_dispatch_at: Date | null;
  high_water_at: Date | null;
  resume_page_token: string | null;
  last_read_units: number;
}

export class PgYouTubeState {
  constructor(private readonly pool: pg.Pool) {}

  /** Takes the connection's lease, or null while another cycle holds it. */
  async claim(
    scope: ConnectionScope,
    now: Date,
    leaseMs = CYCLE_LEASE_MS,
  ): Promise<{ leaseToken: string; state: YouTubeCycleState } | null> {
    const leaseToken = randomUUID();
    await this.pool.query(
      `INSERT INTO youtube_connection_state (organization_id, brand_id, connection_id, next_read_at)
       SELECT c.organization_id, c.brand_id, c.id, $4 FROM connection c
        WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.id = $3
       ON CONFLICT (connection_id) DO NOTHING`,
      [...scopeParams(scope), now],
    );
    const r = await this.pool.query<Row>(
      `UPDATE youtube_connection_state
          SET lease_until = $5, lease_token = $4
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
          AND (lease_until IS NULL OR lease_until < $6)
        RETURNING next_read_at, next_dispatch_at, high_water_at, resume_page_token, last_read_units`,
      [...scopeParams(scope), leaseToken, new Date(now.getTime() + leaseMs), now],
    );
    const row = r.rows[0];
    return row
      ? {
          leaseToken,
          state: {
            nextReadAt: row.next_read_at,
            nextDispatchAt: row.next_dispatch_at,
            highWaterAt: row.high_water_at,
            resumePageToken: row.resume_page_token,
            lastReadUnits: row.last_read_units,
          },
        }
      : null;
  }

  /** Saves the patch and frees the lease. Does nothing when the lease was lost. */
  async release(
    scope: ConnectionScope,
    leaseToken: string,
    now: Date,
    patch: YouTubeStatePatch,
  ): Promise<boolean> {
    const keys = (Object.keys(COLUMNS) as (keyof YouTubeStatePatch)[]).filter(
      (k) => patch[k] !== undefined,
    );
    const sets = keys.map((k, i) => `${COLUMNS[k]} = $${i + 6}`);
    const r = await this.pool.query(
      `UPDATE youtube_connection_state
          SET lease_until = NULL, lease_token = NULL, last_cycle_at = $5${sets.map((s) => `, ${s}`).join('')}
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND lease_token = $4`,
      [...scopeParams(scope), leaseToken, now, ...keys.map((k) => patch[k])],
    );
    return r.rowCount === 1;
  }

  /**
   * Active connections whose read or dispatch is due and whose lease is free. A newly
   * connected channel gets its state row here, so it is due immediately.
   */
  async dueConnections(now: Date, limit: number): Promise<ConnectionScope[]> {
    await this.pool.query(
      `INSERT INTO youtube_connection_state (organization_id, brand_id, connection_id, next_read_at)
       SELECT c.organization_id, c.brand_id, c.id, $1 FROM connection c
        WHERE c.platform = 'youtube' AND c.status = 'active'
       ON CONFLICT (connection_id) DO NOTHING`,
      [now],
    );
    const r = await this.pool.query<{ organization_id: string; brand_id: string; id: string }>(
      `SELECT c.organization_id, c.brand_id, c.id
         FROM connection c
         JOIN youtube_connection_state s ON s.connection_id = c.id
          AND s.organization_id = c.organization_id AND s.brand_id = c.brand_id
        WHERE c.platform = 'youtube' AND c.status = 'active'
          AND (s.next_read_at <= $1 OR s.next_dispatch_at <= $1)
          AND (s.lease_until IS NULL OR s.lease_until < $1)
        ORDER BY LEAST(s.next_read_at, COALESCE(s.next_dispatch_at, s.next_read_at)), c.id
        LIMIT $2`,
      [now, limit],
    );
    return r.rows.map((x) => ({
      organizationId: x.organization_id,
      brandId: x.brand_id,
      connectionId: x.id,
    }));
  }
}
