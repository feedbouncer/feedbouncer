// Comment storage for platform snapshots. Ordering rules (out-of-order webhooks
// and racing fetches are normal):
// - `platform_synced_at` is the time a fetch started; a snapshot only applies
//   when it is strictly newer than the stored one.
// - `deleted` is terminal: no snapshot or action moves a comment out of it.
// Every statement is filtered by organization_id + brand_id (+ connection_id).
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { commentFingerprint, withTransaction } from '@feedbouncer/db';
import type {
  CommentRef,
  ConnectionStatus,
  NormalizedComment,
  Platform,
  PlatformState,
  ReviewModeColumns,
} from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { UUID } from '@feedbouncer/service-runtime';

/** Where a comment first entered the system; written on insert, never updated. */
export type IngestOrigin = 'live' | 'backfill';

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
  /** The parent comment was erased or purged; the reply stays. */
  readonly parentRemoved: boolean;
  readonly authorExternalId: string | null;
  readonly authorName: string | null;
  readonly body: string;
  readonly platformState: PlatformState;
  /** State of the stored parent comment; null for a top-level comment or a parent not stored yet. */
  readonly parentPlatformState: PlatformState | null;
  readonly postedAt: Date;
  readonly permalink: string | null;
  readonly isOwnAccount: boolean;
  readonly connectionStatus: ConnectionStatus;
  /** The connection's review-mode columns, read with the comment. */
  readonly reviewMode: ReviewModeColumns;
  /** A private reply to this comment is pending or applied (the platform allows one). */
  readonly privateReplied: boolean;
  /** 'ad' when its source is an ad post or linked to an ad, or it was also seen through an ad's source. */
  readonly origin: CommentOrigin;
  /** Up to 5 linked ads, by ad id. */
  readonly ads: readonly { adId: string; adAccountId: string }[];
}

export type CommentOrigin = 'ad' | 'organic';

/** Source kinds a connector lists itself (an organic post is created by its first comment). */
export type ListedSourceKind = 'ad_post' | 'video';

/** Position in the newest-first listing: the last row of the previous page. */
export interface CommentCursor {
  readonly postedAt: Date;
  readonly id: string;
}

/** Postgres text cannot hold NUL; same replacement as the connector boundary. */
const noNul = (s: string): string => s.replaceAll('\u0000', '�');
/** A comment body exactly as the store saves it (what `CommentRow.body` returns). Idempotent. */
export const storedCommentBody = noNul;
const outOfScope = () => new Error('comment store: connection is not in the given scope');

/** Over `comment c`: true when the comment came through an ad or sits under an ad post. */
const IS_AD_SQL = `(c.ad_source_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM meta_ad_source mas
     WHERE mas.organization_id = c.organization_id AND mas.brand_id = c.brand_id
       AND mas.source_id = c.source_id) OR EXISTS (
    SELECT 1 FROM source ads
     WHERE ads.id = c.source_id AND ads.organization_id = c.organization_id
       AND ads.brand_id = c.brand_id AND ads.kind = 'ad_post'))`;

export const COMMENT_IS_AD_SQL = IS_AD_SQL;

const ROW_SQL = `
  SELECT c.id, c.connection_id, cn.platform, s.external_id AS source_external_id, c.external_id,
         c.parent_external_id, c.parent_comment_id, (c.parent_removed_at IS NOT NULL) AS parent_removed,
         a.external_id AS author_external_id,
         a.display_name AS author_name, c.body, c.platform_state,
         p.platform_state AS parent_platform_state, c.posted_at, c.permalink,
         c.is_own_account, cn.status AS connection_status,
         cn.review_mode, cn.review_mode_started_at, cn.review_mode_ends_at, cn.review_mode_ended_at,
         EXISTS (SELECT 1 FROM moderation_action ma
                  WHERE ma.comment_id = c.id AND ma.organization_id = c.organization_id
                    AND ma.brand_id = c.brand_id
                    AND ma.kind = 'private_reply' AND ma.status IN ('pending', 'applied'))
           AS private_replied,
         CASE WHEN ${IS_AD_SQL} THEN 'ad' ELSE 'organic' END AS origin,
         COALESCE(ads.ads, '[]'::jsonb) AS ads
    FROM comment c
    JOIN source s ON s.id = c.source_id AND s.organization_id = c.organization_id AND s.brand_id = c.brand_id
    JOIN connection cn ON cn.id = c.connection_id AND cn.organization_id = c.organization_id AND cn.brand_id = c.brand_id
    LEFT JOIN author a ON a.id = c.author_id AND a.connection_id = c.connection_id
    LEFT JOIN comment p ON p.id = c.parent_comment_id AND p.organization_id = c.organization_id AND p.brand_id = c.brand_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('adId', x.external_id, 'adAccountId', x.ad_account_external_id)
                       ORDER BY x.external_id) AS ads
        FROM (SELECT DISTINCT ma.external_id, ma.ad_account_external_id
                FROM meta_ad_source mas
                JOIN meta_ad ma ON ma.id = mas.ad_id AND ma.organization_id = mas.organization_id
                               AND ma.brand_id = mas.brand_id
               WHERE mas.organization_id = c.organization_id AND mas.brand_id = c.brand_id
                 AND mas.source_id IN (c.source_id, c.ad_source_id)
               ORDER BY ma.external_id LIMIT 5) x) ads ON true`;

const toRow = (r: Record<string, unknown>): CommentRow => ({
  id: r.id as string,
  connectionId: r.connection_id as string,
  platform: r.platform as Platform,
  sourceExternalId: r.source_external_id as string,
  externalId: r.external_id as string,
  parentExternalId: (r.parent_external_id as string | null) ?? null,
  parentCommentId: (r.parent_comment_id as string | null) ?? null,
  parentRemoved: r.parent_removed as boolean,
  authorExternalId: (r.author_external_id as string | null) ?? null,
  authorName: (r.author_name as string | null) ?? null,
  body: r.body as string,
  platformState: r.platform_state as PlatformState,
  parentPlatformState: (r.parent_platform_state as PlatformState | null) ?? null,
  postedAt: r.posted_at as Date,
  permalink: (r.permalink as string | null) ?? null,
  isOwnAccount: r.is_own_account as boolean,
  connectionStatus: r.connection_status as ConnectionStatus,
  reviewMode: {
    mode: r.review_mode as ReviewModeColumns['mode'],
    startedAt: (r.review_mode_started_at as Date | null) ?? null,
    endsAt: (r.review_mode_ends_at as Date | null) ?? null,
    endedAt: (r.review_mode_ended_at as Date | null) ?? null,
  },
  privateReplied: r.private_replied as boolean,
  origin: r.origin as CommentOrigin,
  ads: r.ads as { adId: string; adAccountId: string }[],
});

const ids = (s: ConnectionScope) => [s.organizationId, s.brandId, s.connectionId];

/**
 * After our own actions. Never moves a comment out of `deleted`. The one copy
 * of that rule: used by the action executor inside its transaction.
 */
export async function setCommentPlatformState(
  db: pg.Pool | pg.ClientBase,
  scope: ConnectionScope,
  commentId: string,
  state: PlatformState,
): Promise<void> {
  if (!UUID.test(commentId)) return;
  await db.query(
    `UPDATE comment SET platform_state = CASE WHEN platform_state = 'deleted' THEN 'deleted' ELSE $5 END
      WHERE id = $4 AND organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
    [...ids(scope), commentId, state],
  );
}

/** True for a comment erased by a subject request; it must not be stored again. */
async function isErased(
  tx: pg.ClientBase,
  scope: ConnectionScope,
  externalId: string,
): Promise<boolean> {
  const r = await tx.query(
    'SELECT 1 FROM erased_comment WHERE connection_id = $1 AND fingerprint = $2',
    [scope.connectionId, commentFingerprint(scope.connectionId, externalId)],
  );
  return r.rows.length > 0;
}

const ERASED_WHILE_WRITING = Symbol('erased while writing');

/**
 * Runs a write that stores a comment. The erased check is repeated after the
 * write, because an erasure committing while the write waited on the deleted
 * row would otherwise be followed by a fresh insert; the transaction is then rolled back.
 */
async function writeUnlessErased<T>(
  pool: pg.Pool,
  scope: ConnectionScope,
  externalId: string,
  write: (tx: pg.PoolClient) => Promise<T>,
): Promise<T | typeof ERASED_WHILE_WRITING> {
  try {
    return await withTransaction(pool, async (tx) => {
      const result = await write(tx);
      if (await isErased(tx, scope, externalId)) throw ERASED_WHILE_WRITING;
      return result;
    });
  } catch (e) {
    if (e === ERASED_WHILE_WRITING) return ERASED_WHILE_WRITING;
    throw e;
  }
}

/** An existing source keeps its kind: an ad post is never demoted. */
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

/** Upserts a listed source with its kind, promoting an organic one; an ad post is never demoted. */
export async function upsertListedSource(
  tx: pg.Pool | pg.ClientBase,
  scope: ConnectionScope,
  externalId: string,
  kind: ListedSourceKind,
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO source (organization_id, brand_id, connection_id, kind, external_id)
     VALUES ($1, $2, $3, $5, $4)
     ON CONFLICT (connection_id, external_id) DO UPDATE SET
       kind = CASE WHEN source.kind = 'ad_post' THEN 'ad_post' ELSE EXCLUDED.kind END, updated_at = now()
       WHERE source.organization_id = $1 AND source.brand_id = $2
     RETURNING id`,
    [...ids(scope), externalId, kind],
  );
  if (!r.rows[0]) throw outOfScope();
  return r.rows[0].id;
}

/** Re-links replies stored before their parent (in any source of the connection). */
async function linkChildren(
  tx: pg.ClientBase,
  scope: ConnectionScope,
  commentId: string,
  externalId: string,
): Promise<void> {
  await tx.query(
    `UPDATE comment SET parent_comment_id = $4
      WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
        AND parent_external_id = $5 AND parent_comment_id IS NULL`,
    [...ids(scope), commentId, externalId],
  );
}

const bodySha = (body: string): Buffer => createHash('sha256').update(body, 'utf8').digest();

export class PgCommentStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Whether a moderator restored the comment: its newest hide/unhide is a user's unhide that is
   * pending, applied, or recorded because the platform already showed the comment. Automation
   * must not hide it again.
   */
  async userUnhidLast(scope: BrandScope, commentId: string): Promise<boolean> {
    if (!UUID.test(commentId)) return false;
    const r = await this.pool.query<{ kind: string; actor_type: string }>(
      `SELECT kind, actor_type FROM moderation_action
        WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3
          AND kind IN ('hide', 'unhide')
          AND (status IN ('pending', 'applied')
               OR (kind = 'unhide' AND status = 'noop' AND outcome_code = 'already_visible'))
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [scope.organizationId, scope.brandId, commentId],
    );
    const last = r.rows[0];
    return last?.kind === 'unhide' && (last.actor_type === 'user' || last.actor_type === 'api_key');
  }

  /** Live, non-deleted comments of one connection whose body the hook was not yet told about. */
  async pendingHooks(
    scope: ConnectionScope,
    limit: number,
  ): Promise<{ commentId: string; body: string; attempted: boolean }[]> {
    const r = await this.pool.query<{ id: string; body: string; attempted: boolean }>(
      `SELECT id, body, hook_attempted_at IS NOT NULL AS attempted FROM comment
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3
          AND hook_pending_sha256 IS NOT NULL AND platform_state <> 'deleted'
        ORDER BY hook_attempted_at NULLS FIRST, platform_synced_at NULLS FIRST, id
        LIMIT $4`,
      [...ids(scope), limit],
    );
    return r.rows.map((x) => ({ commentId: x.id, body: x.body, attempted: x.attempted }));
  }

  /** Records a failed delivery so the row rotates behind rows not yet tried. */
  async markHookFailed(
    scope: ConnectionScope,
    commentId: string,
    body: string,
    at: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE comment SET hook_attempted_at = $6
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND id = $4
          AND hook_pending_sha256 = $5`,
      [...ids(scope), commentId, bodySha(noNul(body)), at],
    );
  }

  /** Clears the pending hook marker, only while it still names the delivered body version. */
  async markHookDelivered(scope: ConnectionScope, commentId: string, body: string): Promise<void> {
    await this.pool.query(
      `UPDATE comment SET hook_pending_sha256 = NULL, hook_attempted_at = NULL
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND id = $4
          AND hook_pending_sha256 = $5`,
      [...ids(scope), commentId, bodySha(noNul(body))],
    );
  }

  async upsertFromPlatform(
    scope: ConnectionScope,
    c: NormalizedComment,
    o: { ownAccountExternalId: string; syncedAt: Date; origin?: IngestOrigin },
  ): Promise<
    | { suppressed: true }
    | {
        suppressed: false;
        commentId: string;
        created: boolean;
        applied: boolean;
        /** A live body the rule hook has not yet been told about (new, edited, or a failed delivery). */
        hookBody: string | null;
      }
  > {
    const stored = await writeUnlessErased(this.pool, scope, c.externalId, async (tx) => {
      if (await isErased(tx, scope, c.externalId)) return { suppressed: true as const };
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
      // Locks the row so the body compared below is the one this upsert replaces.
      const prev = await tx.query<{ body: string; pending: boolean; state: string }>(
        `SELECT body, hook_pending_sha256 IS NOT NULL AS pending, platform_state AS state FROM comment
          WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND external_id = $4
            FOR UPDATE`,
        [...ids(scope), c.externalId],
      );
      const newBody = noNul(c.body);
      const live = (o.origin ?? 'live') === 'live';
      const newSha = live && c.platformState !== 'deleted' ? bodySha(newBody) : null;
      const up = await tx.query<{ id: string; created: boolean }>(
        `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, author_id,
                              parent_external_id, parent_comment_id, body, platform_state, posted_at,
                              permalink, is_own_account, platform_synced_at, ingest_origin, hook_pending_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text,
                 (SELECT p.id FROM comment p
                   WHERE p.organization_id = $1 AND p.brand_id = $2 AND p.connection_id = $3
                     AND p.external_id = $7::text),
                 $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (connection_id, external_id) DO UPDATE SET
           hook_pending_sha256 = CASE
             WHEN comment.platform_state = 'deleted' OR EXCLUDED.platform_state = 'deleted' THEN NULL
             WHEN comment.body IS DISTINCT FROM EXCLUDED.body THEN EXCLUDED.hook_pending_sha256
             ELSE comment.hook_pending_sha256 END,
           hook_attempted_at = CASE
             WHEN comment.platform_state = 'deleted' OR comment.body IS DISTINCT FROM EXCLUDED.body
               THEN NULL ELSE comment.hook_attempted_at END,
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
          newBody,
          c.platformState,
          c.postedAt,
          c.permalink,
          c.author !== null && c.author.externalId === o.ownAccountExternalId,
          o.syncedAt,
          o.origin ?? 'live',
          newSha,
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
            WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND external_id = $4`,
          [...ids(scope), c.externalId],
        );
        if (!existing.rows[0]) throw outOfScope();
        commentId = existing.rows[0].id;
      }
      await linkChildren(tx, scope, commentId, c.externalId);
      const bodyChanged =
        applied && (created || prev.rows[0] === undefined || prev.rows[0].body !== newBody);
      // A new live body, or an earlier one whose delivery was never recorded.
      const hookBody =
        c.platformState === 'deleted' || prev.rows[0]?.state === 'deleted'
          ? null
          : applied && live && bodyChanged
            ? newBody
            : prev.rows[0]?.pending === true && !(applied && bodyChanged)
              ? prev.rows[0].body
              : null;
      return { suppressed: false as const, commentId, created, applied, hookBody };
    });
    return stored === ERASED_WHILE_WRITING ? { suppressed: true } : stored;
  }

  /** Upserts an ad's post as a source of kind 'ad_post' (promoting an organic one); `tx` joins a caller's transaction. */
  ensureAdSource(
    scope: ConnectionScope,
    sourceExternalId: string,
    tx?: pg.ClientBase,
  ): Promise<string> {
    return upsertListedSource(tx ?? this.pool, scope, sourceExternalId, 'ad_post');
  }

  /**
   * Records that a comment stored under another source was also read through
   * an ad's source. Not a snapshot, so the platform_synced_at rule does not apply.
   */
  async markSeenViaAdSource(
    scope: ConnectionScope,
    commentId: string,
    adSourceId: string,
  ): Promise<void> {
    if (!UUID.test(commentId) || !UUID.test(adSourceId)) return;
    await this.pool.query(
      `UPDATE comment SET ad_source_id = $4, updated_at = now()
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND id = $5
          AND ad_source_id IS NULL AND source_id <> $4
          AND EXISTS (SELECT 1 FROM source s WHERE s.id = $4 AND s.organization_id = $1
                         AND s.brand_id = $2 AND s.connection_id = $3)`,
      [...ids(scope), adSourceId, commentId],
    );
  }

  /** Marks a stored comment deleted (terminal). Unknown comments are not stored: returns null. */
  async markDeleted(
    scope: ConnectionScope,
    ref: CommentRef,
    syncedAt: Date,
  ): Promise<string | null> {
    const r = await this.pool.query<{ id: string }>(
      `UPDATE comment c SET platform_state = 'deleted', hook_pending_sha256 = NULL, hook_attempted_at = NULL,
              platform_synced_at = GREATEST(c.platform_synced_at, $5)
        WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3
          AND c.external_id = $4
       RETURNING c.id`,
      [...ids(scope), ref.externalId, syncedAt],
    );
    return r.rows[0]?.id ?? null;
  }

  /**
   * A platform delete event: marks the comment deleted, or stores a deleted
   * tombstone when it was never seen, so a stale fetch that lands later (the
   * create event's job running after the delete's) cannot store it as visible.
   * `occurredAt` (the event time) stands in for posted_at until a fetch fills it in.
   * Returns null, storing nothing, for a comment erased by a subject request.
   */
  async recordDeleted(
    scope: ConnectionScope,
    ref: CommentRef,
    o: { syncedAt: Date; occurredAt: Date },
  ): Promise<string | null> {
    const id = await writeUnlessErased(this.pool, scope, ref.externalId, async (tx) => {
      if (await isErased(tx, scope, ref.externalId)) return null;
      const sourceId = await upsertSource(tx, scope, ref.sourceExternalId);
      const r = await tx.query<{ id: string }>(
        `INSERT INTO comment (organization_id, brand_id, connection_id, source_id, external_id, body,
                              platform_state, posted_at, platform_synced_at)
         VALUES ($1, $2, $3, $4, $5, '', 'deleted', $6, $7)
         ON CONFLICT (connection_id, external_id) DO UPDATE SET
           platform_state = 'deleted',
           hook_pending_sha256 = NULL,
           hook_attempted_at = NULL,
           platform_synced_at = GREATEST(comment.platform_synced_at, EXCLUDED.platform_synced_at)
         WHERE comment.organization_id = $1 AND comment.brand_id = $2
         RETURNING id`,
        [...ids(scope), sourceId, ref.externalId, o.occurredAt, o.syncedAt],
      );
      if (!r.rows[0]) throw outOfScope();
      await linkChildren(tx, scope, r.rows[0].id, ref.externalId);
      return r.rows[0].id;
    });
    return id === ERASED_WHILE_WRITING ? null : id;
  }

  async load(scope: BrandScope, commentId: string): Promise<CommentRow | null> {
    if (!UUID.test(commentId)) return null;
    const r = await this.pool.query(
      `${ROW_SQL} WHERE c.id = $3 AND c.organization_id = $1 AND c.brand_id = $2`,
      [scope.organizationId, scope.brandId, commentId],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  }

  /** Actor type of the newest pending or applied action on the comment, or null when there is none. */
  async latestActionActor(scope: BrandScope, commentId: string): Promise<string | null> {
    const r = await this.pool.query<{ actor_type: string }>(
      `SELECT actor_type FROM moderation_action
       WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3 AND status IN ('pending', 'applied')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [scope.organizationId, scope.brandId, commentId],
    );
    return r.rows[0]?.actor_type ?? null;
  }

  async list(
    scope: BrandScope,
    q: {
      before: CommentCursor | null;
      limit: number;
      connectionId?: string;
      /** Leaves out deleted comments (and tombstones of never-seen ones) before the limit applies. */
      excludeDeleted?: boolean;
      origin?: CommentOrigin;
    },
  ): Promise<CommentRow[]> {
    if (q.connectionId !== undefined && !UUID.test(q.connectionId)) return [];
    if (q.before !== null && !UUID.test(q.before.id)) return [];
    const limit = Math.min(Math.max(Math.trunc(q.limit) || 1, 1), 100);
    const r = await this.pool.query(
      `${ROW_SQL} WHERE c.organization_id = $1 AND c.brand_id = $2
                   AND ($3::timestamptz IS NULL OR (c.posted_at, c.id) < ($3::timestamptz, $4::uuid))
                   AND ($5::uuid IS NULL OR c.connection_id = $5)
                   AND (NOT $7::boolean OR c.platform_state <> 'deleted')
                   AND ($8::text IS NULL OR (${IS_AD_SQL}) = ($8::text = 'ad'))
                 ORDER BY c.posted_at DESC, c.id DESC LIMIT $6`,
      [
        scope.organizationId,
        scope.brandId,
        q.before?.postedAt ?? null,
        q.before?.id ?? null,
        q.connectionId ?? null,
        limit,
        q.excludeDeleted === true,
        q.origin ?? null,
      ],
    );
    return r.rows.map(toRow);
  }
}
