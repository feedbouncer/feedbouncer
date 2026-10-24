// Poll state of TikTok connections: one connection_poll row per connection
// (organic video discovery, or the advertiser comment listing) and one
// source_poll row per organic video. Every statement is filtered by
// organization_id + brand_id + connection_id, except `dueConnections`, which
// returns ids only to the trusted scheduler.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { ConnectionStatus, NormalizedSource } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { upsertListedSource } from '../store.js';

export type TikTokPollPlatform = 'tiktok' | 'tiktok_ads';
export type ConnectionPollKind = 'tiktok_videos' | 'tiktok_ad_comments';

export interface ConnectionPollState {
  highWaterAt: Date | null;
  passStartedAt: Date | null;
  passNewestAt: Date | null;
  resumePage: number | null;
  resumeCursor: string | null;
  lastPolledAt: Date | null;
  lastFullScanAt: Date | null;
  nextPollAt: Date;
  lastErrorCode: string | null;
}

export interface SourcePollState {
  highWaterAt: Date | null;
  resumeCursor: string | null;
  resumeBoundary: Date | null;
  resumeNewestAt: Date | null;
  lastPolledAt: Date | null;
  lastFullScanAt: Date | null;
  lastCommentAt: Date | null;
  nextPollAt: Date;
  unavailableSince: Date | null;
  lastErrorCode: string | null;
}

export interface ClaimedVideo {
  sourceId: string;
  externalId: string;
  /** When the video was first listed. */
  discoveredAt: Date;
  /** When TikTok says the video was posted; null when it did not say. */
  postedAt: Date | null;
  poll: SourcePollState;
}

/** A claimed video is not handed out again for this long unless its poll is saved first. */
export const CLAIM_LEASE_MS = 600_000;

const KIND_OF: Record<TikTokPollPlatform, ConnectionPollKind> = {
  tiktok: 'tiktok_videos',
  tiktok_ads: 'tiktok_ad_comments',
};

const CONNECTION_COLUMNS = {
  highWaterAt: 'high_water_at',
  passStartedAt: 'pass_started_at',
  passNewestAt: 'pass_newest_at',
  resumePage: 'resume_page',
  resumeCursor: 'resume_cursor',
  lastPolledAt: 'last_polled_at',
  lastFullScanAt: 'last_full_scan_at',
  nextPollAt: 'next_poll_at',
  lastErrorCode: 'last_error_code',
} as const satisfies Record<keyof ConnectionPollState, string>;

const SOURCE_COLUMNS = {
  highWaterAt: 'high_water_at',
  resumeCursor: 'resume_cursor',
  resumeBoundary: 'resume_boundary',
  resumeNewestAt: 'resume_newest_at',
  lastPolledAt: 'last_polled_at',
  lastFullScanAt: 'last_full_scan_at',
  lastCommentAt: 'last_comment_at',
  nextPollAt: 'next_poll_at',
  unavailableSince: 'unavailable_since',
  lastErrorCode: 'last_error_code',
} as const satisfies Record<keyof SourcePollState, string>;

const ids = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];
const outOfScope = () => new Error('tiktok polling: connection is not in the given scope');

const select = <K extends string>(cols: Record<K, string>, alias: string) =>
  Object.values<string>(cols)
    .map((c) => `${alias}.${c}`)
    .join(', ');

function fromRow<T>(cols: Record<string, string>, row: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(cols).map(([k, c]) => [k, row[c] ?? null])) as T;
}

/** `SET a = $n, …` for the given patch, numbered after `offset` parameters. */
function assignments<T extends object>(
  cols: Record<keyof T, string>,
  patch: Partial<T>,
  offset: number,
): { sql: string; values: unknown[] } {
  const keys = (Object.keys(patch) as (keyof T)[]).filter((k) => patch[k] !== undefined);
  return {
    sql: keys.map((k, i) => `${cols[k]} = $${offset + i + 1}`).join(', '),
    values: keys.map((k) => patch[k]),
  };
}

export class PgTikTokPolling {
  constructor(private readonly pool: pg.Pool) {}

  /** Trusted scheduler only. Active connections of `platform` whose connection_poll is due (or missing). Ids only. */
  async dueConnections(
    platform: TikTokPollPlatform,
    now: Date,
    limit: number,
  ): Promise<ConnectionScope[]> {
    const r = await this.pool.query<{ organization_id: string; brand_id: string; id: string }>(
      `SELECT c.organization_id, c.brand_id, c.id FROM connection c
         LEFT JOIN connection_poll cp ON cp.connection_id = c.id
               AND cp.organization_id = c.organization_id AND cp.brand_id = c.brand_id
        WHERE c.platform = $1 AND c.status = 'active'
          AND (cp.connection_id IS NULL OR cp.next_poll_at <= $2
               OR (c.platform = 'tiktok' AND EXISTS (
                     SELECT 1 FROM source_poll sp
                      WHERE sp.organization_id = c.organization_id AND sp.brand_id = c.brand_id
                        AND sp.connection_id = c.id AND sp.next_poll_at <= $2)))
        ORDER BY cp.next_poll_at NULLS FIRST, c.id
        LIMIT $3`,
      [platform, now, limit],
    );
    return r.rows.map((x) => ({
      organizationId: x.organization_id,
      brandId: x.brand_id,
      connectionId: x.id,
    }));
  }

  /** The connection's account id and status, or null outside the scope. */
  async account(
    scope: ConnectionScope,
  ): Promise<{ externalAccountId: string; status: ConnectionStatus } | null> {
    const r = await this.pool.query<{ external_account_id: string; status: ConnectionStatus }>(
      `SELECT external_account_id, status FROM connection
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
      ids(scope),
    );
    const row = r.rows[0];
    return row ? { externalAccountId: row.external_account_id, status: row.status } : null;
  }

  /** Creates the row (due at once) if absent. Throws when the row exists under another kind. */
  async connectionState(
    scope: ConnectionScope,
    kind: ConnectionPollKind,
  ): Promise<ConnectionPollState> {
    await this.pool.query(
      `INSERT INTO connection_poll (connection_id, organization_id, brand_id, kind, next_poll_at)
       SELECT id, organization_id, brand_id, $4, to_timestamp(0) FROM connection
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND platform = $5
       ON CONFLICT (connection_id) DO NOTHING`,
      [...ids(scope), kind, kind === KIND_OF.tiktok ? 'tiktok' : 'tiktok_ads'],
    );
    const r = await this.pool.query(
      `SELECT ${select(CONNECTION_COLUMNS, 'cp')} FROM connection_poll cp
        WHERE cp.organization_id = $1 AND cp.brand_id = $2 AND cp.connection_id = $3 AND cp.kind = $4`,
      [...ids(scope), kind],
    );
    if (!r.rows[0]) throw outOfScope();
    return fromRow(CONNECTION_COLUMNS, r.rows[0]);
  }

  async saveConnectionState(
    scope: ConnectionScope,
    patch: Partial<ConnectionPollState>,
  ): Promise<void> {
    const set = assignments(CONNECTION_COLUMNS, patch, 3);
    if (set.values.length === 0) return;
    await this.pool.query(
      `UPDATE connection_poll SET ${set.sql}
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
      [...ids(scope), ...set.values],
    );
  }

  /** Upserts video sources + their source_poll rows; returns source ids by external id. */
  async upsertSources(
    scope: ConnectionScope,
    sources: readonly NormalizedSource[],
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    if (sources.length === 0) return out;
    await withTransaction(this.pool, async (tx) => {
      for (const s of sources) {
        if (s.kind !== 'video' && s.kind !== 'ad_post')
          throw new Error('tiktok polling: unsupported source kind');
        const id = await upsertListedSource(tx, scope, s.externalId, s.kind, s.permalink);
        out.set(s.externalId, id);
        if (s.kind !== 'video') continue;
        if (s.postedAt !== undefined)
          await tx.query(
            `UPDATE source SET metadata = metadata || jsonb_build_object('postedAt', $5::text)
              WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND id = $4`,
            [...ids(scope), id, s.postedAt.toISOString()],
          );
        await tx.query(
          `INSERT INTO source_poll (source_id, organization_id, brand_id, connection_id, next_poll_at)
           VALUES ($4, $1, $2, $3, to_timestamp(0)) ON CONFLICT (source_id) DO NOTHING`,
          [...ids(scope), id],
        );
      }
    });
    return out;
  }

  /**
   * Due video sources: active connection, next_poll_at <= now, unavailable retry elapsed.
   * Ordered last_comment_at DESC NULLS FIRST, next_poll_at. FOR UPDATE SKIP LOCKED, and
   * leased (next_poll_at moves CLAIM_LEASE_MS ahead) until the caller saves the poll.
   */
  async claimDueVideos(scope: ConnectionScope, now: Date, limit: number): Promise<ClaimedVideo[]> {
    const r = await this.pool.query(
      `WITH due AS (
         SELECT sp.source_id, s.external_id, s.created_at AS discovered_at,
                (s.metadata->>'postedAt')::timestamptz AS posted_at, ${select(SOURCE_COLUMNS, 'sp')}
           FROM source_poll sp
           JOIN source s ON s.id = sp.source_id AND s.organization_id = sp.organization_id
                        AND s.brand_id = sp.brand_id AND s.connection_id = sp.connection_id
           JOIN connection c ON c.id = sp.connection_id AND c.organization_id = sp.organization_id
                            AND c.brand_id = sp.brand_id
          WHERE sp.organization_id = $1 AND sp.brand_id = $2 AND sp.connection_id = $3
            AND c.status = 'active' AND s.kind = 'video' AND sp.next_poll_at <= $4
          ORDER BY sp.last_comment_at DESC NULLS FIRST, sp.next_poll_at, sp.source_id
          LIMIT $5
          FOR UPDATE OF sp SKIP LOCKED)
       UPDATE source_poll sp SET next_poll_at = $6 FROM due
        WHERE sp.source_id = due.source_id
          AND sp.organization_id = $1 AND sp.brand_id = $2 AND sp.connection_id = $3
       RETURNING due.*`,
      [...ids(scope), now, limit, new Date(now.getTime() + CLAIM_LEASE_MS)],
    );
    const at = (d: Date | null) => d?.getTime() ?? Infinity;
    return r.rows
      .sort(
        (a, b) =>
          at(b.last_comment_at) - at(a.last_comment_at) ||
          a.next_poll_at.getTime() - b.next_poll_at.getTime() ||
          String(a.source_id).localeCompare(String(b.source_id)),
      )
      .map((x) => ({
        sourceId: x.source_id as string,
        externalId: x.external_id as string,
        discoveredAt: x.discovered_at as Date,
        postedAt: (x.posted_at as Date | null) ?? null,
        poll: fromRow<SourcePollState>(SOURCE_COLUMNS, x),
      }));
  }

  async saveSourcePoll(
    scope: ConnectionScope,
    sourceId: string,
    patch: Partial<SourcePollState>,
  ): Promise<void> {
    const set = assignments(SOURCE_COLUMNS, patch, 4);
    if (set.values.length === 0) return;
    await this.pool.query(
      `UPDATE source_poll SET ${set.sql}
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND source_id = $4`,
      [...ids(scope), sourceId, ...set.values],
    );
  }

  /** Comments of the connection stored with origin 'backfill' (the first-pass cap counts them). */
  async backfilledCount(scope: ConnectionScope): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM comment
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
          AND ingest_origin = 'backfill'`,
      ids(scope),
    );
    return Number(r.rows[0]!.n);
  }
}
