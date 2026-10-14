// Per-connection backfill run state. Every statement is filtered by
// organization_id + brand_id + connection_id; `now` is passed in so tests control time.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { BACKFILL_DEFAULTS, type BackfillSettings } from './settings.js';

export type BackfillStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BackfillRun {
  runId: string;
  status: BackfillStatus;
  segment: number;
  windowStart: Date;
  windowEnd: Date;
  maxComments: number;
  sourcesExhausted: boolean;
  sourceCursor: string | null;
  sourceQueue: string[];
  commentCursor: string | null;
  importedCount: number;
  sourcesDone: number;
  skippedCount: number;
}

export type RequestResult =
  | { kind: 'started' | 'existing'; runId: string; segment: number }
  | { kind: 'up_to_date' };

export interface BackfillCheckpoint {
  sourceCursor: string | null;
  sourcesExhausted: boolean;
  sourceQueue: string[];
  commentCursor: string | null;
  importedDelta: number;
  sourcesDoneDelta: number;
  skipped?: { source: string; code: string };
}

export interface BackfillView {
  status: BackfillStatus;
  failureReason: string | null;
  importedCount: number;
  completedAt: Date | null;
  limitedTo: number | null;
  skippedCount: number;
}

const DAY = 86_400_000;
const T = `organization_id = $1 AND brand_id = $2 AND connection_id = $3`;
const key = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];

export class PgBackfillStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly s: BackfillSettings = BACKFILL_DEFAULTS,
  ) {}

  async request(scope: ConnectionScope, now: Date): Promise<RequestResult> {
    return withTransaction(this.pool, async (c) => {
      const prev = (
        await c.query(
          `SELECT run_id, status, segment, synced_through, heartbeat_at FROM connection_backfill WHERE ${T} FOR UPDATE`,
          key(scope),
        )
      ).rows[0] as
        | {
            run_id: string;
            status: string;
            segment: number;
            synced_through: Date | null;
            heartbeat_at: Date;
          }
        | undefined;
      const fresh =
        prev !== undefined && now.getTime() - prev.heartbeat_at.getTime() < this.s.staleAfterMs;
      if (prev && fresh && (prev.status === 'pending' || prev.status === 'running'))
        return { kind: 'existing', runId: prev.run_id, segment: prev.segment };
      const floor = new Date(now.getTime() - this.s.windowDays * DAY);
      let windowStart = floor;
      if (prev?.synced_through) {
        const o = await c.query<{ at: Date | null }>(
          `SELECT min(created_at) AS at FROM audit_event
            WHERE organization_id = $1 AND brand_id = $2 AND subject_type = 'connection' AND subject_id = $3
              AND action IN ('connection.reconnect_required', 'connection.disconnected')
              AND created_at > $4`,
          [...key(scope), prev.synced_through],
        );
        const outage = o.rows[0]?.at ?? null;
        if (outage === null) return { kind: 'up_to_date' };
        windowStart = new Date(Math.max(floor.getTime(), outage.getTime() - this.s.gapOverlapMs));
      }
      const r = await c.query<{ run_id: string }>(
        `INSERT INTO connection_backfill (connection_id, organization_id, brand_id, run_id, status,
                                          window_start, window_end, max_comments, requested_at, heartbeat_at)
         VALUES ($3, $1, $2, gen_random_uuid(), 'pending', $4, $5, $6, $5, $5)
         ON CONFLICT (connection_id) DO UPDATE SET
           run_id = EXCLUDED.run_id, status = 'pending', failure_reason = NULL,
           window_start = EXCLUDED.window_start, window_end = EXCLUDED.window_end,
           segment = 0, sources_exhausted = false, source_cursor = NULL, source_queue = '{}',
           comment_cursor = NULL, imported_count = 0, sources_done = 0, skipped_count = 0,
           skipped_sources = '[]'::jsonb, max_comments = EXCLUDED.max_comments, limited = false,
           requested_at = EXCLUDED.requested_at, started_at = NULL, completed_at = NULL,
           heartbeat_at = EXCLUDED.heartbeat_at
         WHERE connection_backfill.organization_id = $1 AND connection_backfill.brand_id = $2
         RETURNING run_id`,
        [...key(scope), windowStart, now, this.s.maxComments],
      );
      return { kind: 'started', runId: r.rows[0]!.run_id, segment: 0 };
    });
  }

  async claim(
    scope: ConnectionScope,
    runId: string,
    segment: number,
    now: Date,
  ): Promise<BackfillRun | null> {
    const r = await this.pool.query(
      `UPDATE connection_backfill SET status = 'running', segment = $5,
              started_at = COALESCE(started_at, $6), heartbeat_at = $6
        WHERE ${T} AND run_id = $4 AND status IN ('pending', 'running') AND $5 IN (segment, segment + 1)
        RETURNING run_id, status, segment, window_start, window_end, max_comments, sources_exhausted,
                  source_cursor, source_queue, comment_cursor, imported_count, sources_done, skipped_count`,
      [...key(scope), runId, segment, now],
    );
    const x = r.rows[0];
    return x
      ? {
          runId: x.run_id,
          status: x.status,
          segment: x.segment,
          windowStart: x.window_start,
          windowEnd: x.window_end,
          maxComments: x.max_comments,
          sourcesExhausted: x.sources_exhausted,
          sourceCursor: x.source_cursor,
          sourceQueue: x.source_queue,
          commentCursor: x.comment_cursor,
          importedCount: x.imported_count,
          sourcesDone: x.sources_done,
          skippedCount: x.skipped_count,
        }
      : null;
  }

  async checkpoint(
    scope: ConnectionScope,
    runId: string,
    c: BackfillCheckpoint,
    now: Date,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE connection_backfill SET
         source_cursor = $5, sources_exhausted = $6, source_queue = $7::text[], comment_cursor = $8,
         imported_count = imported_count + $9, sources_done = sources_done + $10,
         skipped_count = skipped_count + CASE WHEN $11::jsonb IS NULL THEN 0 ELSE 1 END,
         skipped_sources = CASE
           WHEN $11::jsonb IS NULL OR jsonb_array_length(skipped_sources) >= $12 THEN skipped_sources
           ELSE skipped_sources || jsonb_build_array($11::jsonb) END,
         heartbeat_at = $13
       WHERE ${T} AND run_id = $4 AND status = 'running'`,
      [
        ...key(scope),
        runId,
        c.sourceCursor,
        c.sourcesExhausted,
        c.sourceQueue,
        c.commentCursor,
        c.importedDelta,
        c.sourcesDoneDelta,
        c.skipped ? JSON.stringify(c.skipped) : null,
        this.s.maxSkippedRecorded,
        now,
      ],
    );
    return r.rowCount === 1;
  }

  async complete(
    scope: ConnectionScope,
    runId: string,
    o: { limited: boolean },
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE connection_backfill SET status = 'completed', limited = $5, completed_at = $6, heartbeat_at = $6,
              synced_through = window_end, source_cursor = NULL, source_queue = '{}', comment_cursor = NULL
        WHERE ${T} AND run_id = $4 AND status = 'running'`,
      [...key(scope), runId, o.limited, now],
    );
  }

  async fail(scope: ConnectionScope, runId: string, reason: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE connection_backfill SET status = 'failed', failure_reason = $5, heartbeat_at = $6
        WHERE ${T} AND run_id = $4 AND status IN ('pending', 'running')`,
      [...key(scope), runId, reason, now],
    );
  }

  async cancel(scope: ConnectionScope, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE connection_backfill SET status = 'failed', failure_reason = 'cancelled', heartbeat_at = $4
        WHERE ${T} AND status IN ('pending', 'running')`,
      [...key(scope), now],
    );
  }

  async views(
    scope: { organizationId: string; brandId: string },
    now: Date,
  ): Promise<Map<string, BackfillView>> {
    const r = await this.pool.query(
      `SELECT connection_id, status, failure_reason, imported_count, completed_at, limited, max_comments,
              skipped_count, heartbeat_at
         FROM connection_backfill WHERE organization_id = $1 AND brand_id = $2`,
      [scope.organizationId, scope.brandId],
    );
    const m = new Map<string, BackfillView>();
    for (const x of r.rows) {
      const stale =
        (x.status === 'pending' || x.status === 'running') &&
        now.getTime() - x.heartbeat_at.getTime() >= this.s.staleAfterMs;
      m.set(x.connection_id, {
        status: stale ? 'failed' : x.status,
        failureReason: stale ? 'stalled' : x.failure_reason,
        importedCount: x.imported_count,
        completedAt: x.completed_at,
        limitedTo: x.status === 'completed' && x.limited ? x.max_comments : null,
        skippedCount: x.skipped_count,
      });
    }
    return m;
  }
}
