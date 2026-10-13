// Comment storage for platform snapshots. Ordering rules (out-of-order webhooks
// and racing fetches are normal):
// - `platform_synced_at` is the time a fetch started; a snapshot only applies
//   when it is strictly newer than the stored one.
// - `deleted` is terminal: no snapshot or action moves a comment out of it.
// Every statement is filtered by organization_id + brand_id (+ connection_id).
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type {
  CommentRef,
  ConnectionStatus,
  NormalizedComment,
  Platform,
  PlatformState,
} from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';

export interface BrandScope {
  readonly organizationId: string;
  readonly brandId: string;
}

export interface CommentRow {
  readonly id: string;
  readonly connectionId: string;
  readonly platform: Platform;
  readonly sourceExternalId: string;
  readonly externalId: string;
  readonly parentExternalId: string | null;
  readonly parentCommentId: string | null;
  readonly authorExternalId: string | null;
  readonly authorName: string | null;
  readonly body: string;
  readonly platformState: PlatformState;
  readonly postedAt: Date;
  readonly permalink: string | null;
  readonly isOwnAccount: boolean;
  readonly connectionStatus: ConnectionStatus;
}

/** Postgres text cannot hold NUL; same replacement as the connector boundary. */
const noNul = (s: string): string => s.replaceAll('\u0000', '�');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const outOfScope = () => new Error('comment store: connection is not in the given scope');

const ROW_SQL = `
  SELECT c.id, c.connection_id, cn.platform, s.external_id AS source_external_id, c.external_id,
         c.parent_external_id, c.parent_comment_id, a.external_id AS author_external_id,
         a.display_name AS author_name, c.body, c.platform_state, c.posted_at, c.permalink,
         c.is_own_account, cn.status AS connection_status
    FROM comment c
    JOIN source s ON s.id = c.source_id AND s.organization_id = c.organization_id AND s.brand_id = c.brand_id
    JOIN connection cn ON cn.id = c.connection_id AND cn.organization_id = c.organization_id AND cn.brand_id = c.brand_id
    LEFT JOIN author a ON a.id = c.author_id AND a.connection_id = c.connection_id`;

const toRow = (r: Record<string, unknown>): CommentRow => ({
  id: r.id as string,
  connectionId: r.connection_id as string,
  platform: r.platform as Platform,
  sourceExternalId: r.source_external_id as string,
  externalId: r.external_id as string,
  parentExternalId: (r.parent_external_id as string | null) ?? null,
  parentCommentId: (r.parent_comment_id as string | null) ?? null,
  authorExternalId: (r.author_external_id as string | null) ?? null,
  authorName: (r.author_name as string | null) ?? null,
  body: r.body as string,
  platformState: r.platform_state as PlatformState,
  postedAt: r.posted_at as Date,
  permalink: (r.permalink as string | null) ?? null,
  isOwnAccount: r.is_own_account as boolean,
  connectionStatus: r.connection_status as ConnectionStatus,
});

const ids = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];

async function upsertSource(
  tx: pg.ClientBase,
  scope: ConnectionScope,
  externalId: string,
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, 'organic_post', $4)
     ON CONFLICT (connection_id, external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       WHERE source.organization_id = $1 AND source.brand_id = $2
     RETURNING id`,
    [...ids(scope), externalId],
  );
  if (!r.rows[0]) throw outOfScope();
  return r.rows[0].id;
}

/** Re-links replies stored before their parent. */
async function linkChildren(
  tx: pg.ClientBase,
  scope: ConnectionScope,
  sourceId: string,
  commentId: string,
  externalId: string,
): Promise<void> {
  await tx.query(
    `UPDATE comment SET parent_comment_id = $3
      WHERE organization_id = $1 AND brand_id = $2 AND source_id = $4
        AND parent_external_id = $5 AND parent_comment_id IS NULL`,
    [scope.organizationId, scope.brandId, commentId, sourceId, externalId],
  );
}

export class PgCommentStore {
  constructor(private readonly pool: pg.Pool) {}

  async upsertFromPlatform(
    scope: ConnectionScope,
    c: NormalizedComment,
    o: { ownAccountExternalId: string; syncedAt: Date },
  ): Promise<{ commentId: string; created: boolean; applied: boolean }> {
    return withTransaction(this.pool, async (tx) => {
      const sourceId = await upsertSource(tx, scope, c.sourceExternalId);
      let authorId: string | null = null;
      if (c.author) {
        // An anonymized author keeps display_name NULL (author_anonymized_check).
        const a = await tx.query<{ id: string }>(
          `INSERT INTO author (organization_id, brand_id, connection_id, external_id, display_name)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (connection_id, external_id) DO UPDATE SET display_name =
             CASE WHEN author.anonymized_at IS NOT NULL THEN NULL
                  ELSE COALESCE(EXCLUDED.display_name, author.display_name) END
             WHERE author.organization_id = $1 AND author.brand_id = $2
           RETURNING id`,
          [
            ...ids(scope),
            c.author.externalId,
            c.author.displayName === null ? null : noNul(c.author.displayName),
          ],
        );
        if (!a.rows[0]) throw outOfScope();
        authorId = a.rows[0].id;
      }
      const up = await tx.query<{ id: string; created: boolean }>(
        `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id,
                              parent_external_id, parent_comment_id, body, platform_state, posted_at,
                              permalink, is_own_account, platform_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text,
                 (SELECT p.id FROM comment p
                   WHERE p.organization_id = $1 AND p.brand_id = $2 AND p.source_id = $4
                     AND p.external_id = $7::text),
                 $8, $9, $10, $11, $12, $13)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           body = EXCLUDED.body,
           author_id = COALESCE(EXCLUDED.author_id, comment.author_id),
           parent_external_id = COALESCE(comment.parent_external_id, EXCLUDED.parent_external_id),
           parent_comment_id = COALESCE(comment.parent_comment_id, EXCLUDED.parent_comment_id),
           platform_state = CASE WHEN comment.platform_state = 'deleted' THEN 'deleted'
                                 ELSE EXCLUDED.platform_state END,
           posted_at = EXCLUDED.posted_at,
           permalink = COALESCE(EXCLUDED.permalink, comment.permalink),
           is_own_account = EXCLUDED.is_own_account,
           platform_synced_at = EXCLUDED.platform_synced_at
         WHERE comment.organization_id = $1 AND comment.brand_id = $2
           AND (comment.platform_synced_at IS NULL OR comment.platform_synced_at < EXCLUDED.platform_synced_at)
         RETURNING id, (xmax = 0) AS created`,
        [
          ...ids(scope),
          sourceId,
          c.externalId,
          authorId,
          c.parentExternalId,
          noNul(c.body),
          c.platformState,
          c.postedAt,
          c.permalink,
          c.author !== null && c.author.externalId === o.ownAccountExternalId,
          o.syncedAt,
        ],
      );
      let commentId: string;
      let created = false;
      let applied = true;
      if (up.rows[0]) {
        commentId = up.rows[0].id;
        created = up.rows[0].created;
      } else {
        applied = false;
        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM comment
            WHERE organization_id = $1 AND brand_id = $2 AND source_id = $3 AND external_id = $4`,
          [scope.organizationId, scope.brandId, sourceId, c.externalId],
        );
        if (!existing.rows[0]) throw outOfScope();
        commentId = existing.rows[0].id;
      }
      await linkChildren(tx, scope, sourceId, commentId, c.externalId);
      return { commentId, created, applied };
    });
  }

  /** Marks a stored comment deleted (terminal). Unknown comments are not stored: returns null. */
  async markDeleted(
    scope: ConnectionScope,
    ref: CommentRef,
    syncedAt: Date,
  ): Promise<string | null> {
    const r = await this.pool.query<{ id: string }>(
      `UPDATE comment c SET platform_state = 'deleted',
              platform_synced_at = GREATEST(c.platform_synced_at, $6)
         FROM source s
        WHERE s.id = c.source_id AND s.organization_id = $1 AND s.brand_id = $2
          AND s.connection_id = $3 AND s.external_id = $4 AND c.external_id = $5
          AND c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3
       RETURNING c.id`,
      [...ids(scope), ref.sourceExternalId, ref.externalId, syncedAt],
    );
    return r.rows[0]?.id ?? null;
  }

  /**
   * A platform delete event: marks the comment deleted, or stores a deleted
   * tombstone when it was never seen, so a stale fetch that lands later (the
   * create event's job running after the delete's) cannot store it as visible.
   * `occurredAt` (the event time) stands in for posted_at until a fetch fills it in.
   */
  async recordDeleted(
    scope: ConnectionScope,
    ref: CommentRef,
    o: { syncedAt: Date; occurredAt: Date },
  ): Promise<string> {
    return withTransaction(this.pool, async (tx) => {
      const sourceId = await upsertSource(tx, scope, ref.sourceExternalId);
      const r = await tx.query<{ id: string }>(
        `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
                              platform_state, posted_at, platform_synced_at)
         VALUES ($1, $2, $3, $4, $5, '', 'deleted', $6, $7)
         ON CONFLICT (source_id, external_id) DO UPDATE SET
           platform_state = 'deleted',
           platform_synced_at = GREATEST(comment.platform_synced_at, EXCLUDED.platform_synced_at)
         WHERE comment.organization_id = $1 AND comment.brand_id = $2
         RETURNING id`,
        [...ids(scope), sourceId, ref.externalId, o.occurredAt, o.syncedAt],
      );
      if (!r.rows[0]) throw outOfScope();
      await linkChildren(tx, scope, sourceId, r.rows[0].id, ref.externalId);
      return r.rows[0].id;
    });
  }

  /** After our own actions. Never moves a comment out of `deleted`. */
  async setPlatformState(
    scope: ConnectionScope,
    commentId: string,
    state: PlatformState,
  ): Promise<void> {
    if (!UUID.test(commentId)) return;
    await this.pool.query(
      `UPDATE comment SET platform_state = CASE WHEN platform_state = 'deleted' THEN 'deleted' ELSE $5 END
        WHERE id = $4 AND organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
      [...ids(scope), commentId, state],
    );
  }

  async load(scope: BrandScope, commentId: string): Promise<CommentRow | null> {
    if (!UUID.test(commentId)) return null;
    const r = await this.pool.query(
      `${ROW_SQL} WHERE c.id = $3 AND c.organization_id = $1 AND c.brand_id = $2`,
      [scope.organizationId, scope.brandId, commentId],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  }

  async list(
    scope: BrandScope,
    q: { before: Date | null; limit: number; connectionId?: string },
  ): Promise<CommentRow[]> {
    if (q.connectionId !== undefined && !UUID.test(q.connectionId)) return [];
    const limit = Math.min(Math.max(Math.trunc(q.limit) || 1, 1), 100);
    const r = await this.pool.query(
      `${ROW_SQL} WHERE c.organization_id = $1 AND c.brand_id = $2
                   AND ($3::timestamptz IS NULL OR c.posted_at < $3)
                   AND ($4::uuid IS NULL OR c.connection_id = $4)
                 ORDER BY c.posted_at DESC, c.id DESC LIMIT $5`,
      [scope.organizationId, scope.brandId, q.before, q.connectionId ?? null, limit],
    );
    return r.rows.map(toRow);
  }
}
