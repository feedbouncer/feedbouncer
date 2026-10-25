// Poll state of Threads connections: one connection_poll row for post discovery, one
// source_poll row per post and one threads_pending_reply row per reply a webhook
// announced that no pass has read yet. Every statement is filtered by organization_id +
// brand_id + connection_id, except `dueConnections`, which returns ids only to the
// trusted scheduler.
import type pg from 'pg';
import { THREADS_PENDING_MAX_ATTEMPTS } from '@feedbouncer/connector-threads';
import type { NormalizedSource } from '@feedbouncer/connectors';
import { withTransaction } from '@feedbouncer/db';
import type { ConnectionScope } from '@feedbouncer/secrets';
import {
  SOURCE_COLUMNS,
  assignments,
  fromRow,
  select,
  type SourcePollState,
} from '../poll-columns.js';
import { upsertListedSource } from '../store.js';
import { CLAIM_LEASE_MS } from '../tiktok/polling.js';

const ids = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];
const outOfScope = () => new Error('threads polling: connection is not in the given scope');

/** Post discovery: where the listing of the account's posts stands. */
export interface DiscoveryState {
  lastPolledAt: Date | null;
  /** Set once the connection's first pass (the backfill) is over. */
  lastFullScanAt: Date | null;
  nextPollAt: Date;
}

const DISCOVERY_COLUMNS = {
  lastPolledAt: 'last_polled_at',
  lastFullScanAt: 'last_full_scan_at',
  nextPollAt: 'next_poll_at',
} as const satisfies Record<keyof DiscoveryState, string>;

export interface ClaimedThread {
  sourceId: string;
  externalId: string;
  /** When Threads says the post was published; null for a post only a webhook named. */
  postedAt: Date | null;
  /** True: listed by the account. Null: not checked yet. */
  ownerVerified: boolean | null;
  poll: SourcePollState;
}

export interface ThreadsWake {
  /** The root post the reply belongs to. */
  readonly sourceExternalId: string;
  readonly replyExternalId: string;
  readonly receivedAt: Date;
}

export class PgThreadsPolling {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * A webhook said a post has a new reply. Upserts the post (kind 'thread') and its
   * source_poll row with next_poll_at = LEAST(next_poll_at, receivedAt), and the pending
   * reply, in one transaction. A post already found to belong to another account gets no
   * pending row: nothing will ever read it.
   */
  async recordWake(scope: ConnectionScope, w: ThreadsWake): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      const sourceId = await upsertListedSource(tx, scope, w.sourceExternalId, 'thread');
      const poll = await tx.query<{ owner_verified: boolean | null }>(
        `INSERT INTO source_poll (source_id, organization_id, brand_id, connection_id, next_poll_at)
         VALUES ($4, $1, $2, $3, $5)
         ON CONFLICT (source_id) DO UPDATE
           SET next_poll_at = LEAST(source_poll.next_poll_at, EXCLUDED.next_poll_at)
           WHERE source_poll.organization_id = $1 AND source_poll.brand_id = $2
             AND source_poll.connection_id = $3
         RETURNING owner_verified`,
        [...ids(scope), sourceId, w.receivedAt],
      );
      if (!poll.rows[0]) throw new Error('threads polling: source is not in the given scope');
      if (poll.rows[0].owner_verified === false) return;
      await tx.query(
        `INSERT INTO threads_pending_reply
           (organization_id, brand_id, connection_id, external_id, source_external_id, received_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (connection_id, external_id) DO NOTHING`,
        [...ids(scope), w.replyExternalId, w.sourceExternalId, w.receivedAt],
      );
    });
  }

  /** Trusted scheduler only. Active connections with discovery due (or never run) or a due post. Ids only. */
  async dueConnections(now: Date, limit: number): Promise<ConnectionScope[]> {
    const r = await this.pool.query<{ organization_id: string; brand_id: string; id: string }>(
      `SELECT c.organization_id, c.brand_id, c.id FROM connection c
         LEFT JOIN connection_poll cp ON cp.connection_id = c.id
               AND cp.organization_id = c.organization_id AND cp.brand_id = c.brand_id
        WHERE c.platform = 'threads' AND c.status = 'active'
          AND (cp.connection_id IS NULL OR cp.next_poll_at <= $1
               OR EXISTS (SELECT 1 FROM source_poll sp
                           WHERE sp.organization_id = c.organization_id AND sp.brand_id = c.brand_id
                             AND sp.connection_id = c.id AND sp.next_poll_at <= $1
                             AND sp.owner_verified IS DISTINCT FROM false))
        ORDER BY cp.next_poll_at NULLS FIRST, c.id
        LIMIT $2`,
      [now, limit],
    );
    return r.rows.map((x) => ({
      organizationId: x.organization_id,
      brandId: x.brand_id,
      connectionId: x.id,
    }));
  }

  /** Creates the row (due at once) if absent. Throws outside the scope or for a non-Threads connection. */
  async discoveryState(scope: ConnectionScope): Promise<DiscoveryState> {
    await this.pool.query(
      `INSERT INTO connection_poll (connection_id, organization_id, brand_id, kind, next_poll_at)
       SELECT id, organization_id, brand_id, 'threads_posts', to_timestamp(0) FROM connection
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND platform = 'threads'
       ON CONFLICT (connection_id) DO NOTHING`,
      ids(scope),
    );
    const r = await this.pool.query(
      `SELECT ${select(DISCOVERY_COLUMNS, 'cp')} FROM connection_poll cp
        WHERE cp.organization_id = $1 AND cp.brand_id = $2 AND cp.connection_id = $3
          AND cp.kind = 'threads_posts'`,
      ids(scope),
    );
    if (!r.rows[0]) throw outOfScope();
    return fromRow(DISCOVERY_COLUMNS, r.rows[0]);
  }

  async saveDiscovery(scope: ConnectionScope, patch: Partial<DiscoveryState>): Promise<void> {
    const set = assignments(DISCOVERY_COLUMNS, patch, 3);
    if (set.values.length === 0) return;
    await this.pool.query(
      `UPDATE connection_poll SET ${set.sql}
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
      [...ids(scope), ...set.values],
    );
  }

  /**
   * Upserts listed posts with their source_poll rows. The account itself listed them, so they
   * are marked owner_verified; a new row is due at once, an existing one keeps its schedule.
   */
  async upsertSources(scope: ConnectionScope, sources: readonly NormalizedSource[]): Promise<void> {
    if (sources.length === 0) return;
    await withTransaction(this.pool, async (tx) => {
      for (const s of sources) {
        if (s.kind !== 'thread') throw new Error('threads polling: unsupported source kind');
        const id = await upsertListedSource(tx, scope, s.externalId, 'thread', s.permalink);
        if (s.postedAt !== undefined)
          await tx.query(
            `UPDATE source SET metadata = metadata || jsonb_build_object('postedAt', $5::text)
              WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND id = $4`,
            [...ids(scope), id, s.postedAt.toISOString()],
          );
        await tx.query(
          `INSERT INTO source_poll (source_id, organization_id, brand_id, connection_id, next_poll_at, owner_verified)
           VALUES ($4, $1, $2, $3, to_timestamp(0), true)
           ON CONFLICT (source_id) DO UPDATE SET owner_verified = true
             WHERE source_poll.organization_id = $1 AND source_poll.brand_id = $2
               AND source_poll.connection_id = $3`,
          [...ids(scope), id],
        );
      }
    });
  }

  /**
   * Due posts of an active connection, oldest due first, skipping posts found to belong to
   * another account. FOR UPDATE SKIP LOCKED, and leased (next_poll_at moves CLAIM_LEASE_MS
   * ahead) until the caller saves the poll. A post that could not be read is not due again
   * before its retry time, which is how unavailable posts stay out.
   */
  async claimDueSources(
    scope: ConnectionScope,
    now: Date,
    limit: number,
  ): Promise<ClaimedThread[]> {
    const r = await this.pool.query(
      `WITH due AS (
         SELECT sp.source_id, s.external_id, sp.owner_verified,
                (s.metadata->>'postedAt')::timestamptz AS posted_at, ${select(SOURCE_COLUMNS, 'sp')}
           FROM source_poll sp
           JOIN source s ON s.id = sp.source_id AND s.organization_id = sp.organization_id
                        AND s.brand_id = sp.brand_id AND s.connection_id = sp.connection_id
           JOIN connection c ON c.id = sp.connection_id AND c.organization_id = sp.organization_id
                            AND c.brand_id = sp.brand_id
          WHERE sp.organization_id = $1 AND sp.brand_id = $2 AND sp.connection_id = $3
            AND c.status = 'active' AND s.kind = 'thread' AND sp.next_poll_at <= $4
            AND sp.owner_verified IS DISTINCT FROM false
          ORDER BY sp.next_poll_at, sp.source_id
          LIMIT $5
          FOR UPDATE OF sp SKIP LOCKED)
       UPDATE source_poll sp SET next_poll_at = $6 FROM due
        WHERE sp.source_id = due.source_id
          AND sp.organization_id = $1 AND sp.brand_id = $2 AND sp.connection_id = $3
       RETURNING due.*`,
      [...ids(scope), now, limit, new Date(now.getTime() + CLAIM_LEASE_MS)],
    );
    return r.rows
      .sort(
        (a, b) =>
          a.next_poll_at.getTime() - b.next_poll_at.getTime() ||
          String(a.source_id).localeCompare(String(b.source_id)),
      )
      .map((x) => ({
        sourceId: x.source_id as string,
        externalId: x.external_id as string,
        postedAt: (x.posted_at as Date | null) ?? null,
        ownerVerified: (x.owner_verified as boolean | null) ?? null,
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

  /** Records the ownership check. A post found foreign also loses its pending replies. */
  async setOwnerVerified(scope: ConnectionScope, sourceId: string, ok: boolean): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      const r = await tx.query<{ external_id: string }>(
        `UPDATE source_poll sp SET owner_verified = $5 FROM source s
          WHERE sp.organization_id = $1 AND sp.brand_id = $2 AND sp.connection_id = $3
            AND sp.source_id = $4 AND s.id = sp.source_id AND s.organization_id = sp.organization_id
            AND s.brand_id = sp.brand_id AND s.connection_id = sp.connection_id
        RETURNING s.external_id`,
        [...ids(scope), sourceId, ok],
      );
      if (ok || !r.rows[0]) return;
      await tx.query(
        `DELETE FROM threads_pending_reply
          WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
            AND source_external_id = $4`,
        [...ids(scope), r.rows[0].external_id],
      );
    });
  }

  /** The post's unresolved replies, oldest announcement first. */
  async pendingFor(
    scope: ConnectionScope,
    sourceExternalId: string,
    limit: number,
  ): Promise<{ externalId: string; attempts: number }[]> {
    const r = await this.pool.query<{ external_id: string; attempts: number }>(
      `SELECT external_id, attempts FROM threads_pending_reply
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
          AND source_external_id = $4
        ORDER BY received_at, external_id
        LIMIT $5`,
      [...ids(scope), sourceExternalId, limit],
    );
    return r.rows.map((x) => ({ externalId: x.external_id, attempts: x.attempts }));
  }

  async resolvePending(scope: ConnectionScope, externalIds: readonly string[]): Promise<void> {
    if (externalIds.length === 0) return;
    await this.pool.query(
      `DELETE FROM threads_pending_reply
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
          AND external_id = ANY($4::text[])`,
      [...ids(scope), externalIds],
    );
  }

  /** One more failed lookup for each id. Rows that reach the attempt limit are deleted; returns how many. */
  async bumpPending(scope: ConnectionScope, externalIds: readonly string[]): Promise<number> {
    if (externalIds.length === 0) return 0;
    return withTransaction(this.pool, async (tx) => {
      await tx.query(
        `UPDATE threads_pending_reply SET attempts = attempts + 1
          WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
            AND external_id = ANY($4::text[])`,
        [...ids(scope), externalIds],
      );
      const dropped = await tx.query(
        `DELETE FROM threads_pending_reply
          WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
            AND external_id = ANY($4::text[]) AND attempts >= $5`,
        [...ids(scope), externalIds, THREADS_PENDING_MAX_ATTEMPTS],
      );
      return dropped.rowCount ?? 0;
    });
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
