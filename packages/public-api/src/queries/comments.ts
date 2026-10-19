import type pg from 'pg';
import type { CommentRow } from '../resources/comment.js';

export interface CommentFilters {
  status?: 'visible' | 'hidden' | 'flagged' | undefined;
  brandId?: string | undefined;
  postedFrom?: Date | undefined;
  postedTo?: Date | undefined;
}

export interface CommentPage {
  limit: number;
  after?: { t: Date; id: string } | undefined;
}

type Db = pg.Pool | pg.ClientBase;

const OPEN_REVIEW_ITEM = `EXISTS (SELECT 1 FROM review_item r WHERE r.comment_id = c.id AND r.status = 'open')`;

const SELECT = `
  SELECT c.id, c.brand_id AS "brandId", c.connection_id AS "connectionId", cn.platform,
         c.external_id AS "externalId", c.parent_comment_id AS "parentId",
         a.display_name AS "authorDisplayName", a.anonymized_at AS "authorAnonymizedAt",
         c.body, c.posted_at AS "postedAt", c.ingested_at AS "ingestedAt",
         c.platform_state AS "platformState", ${OPEN_REVIEW_ITEM} AS "hasOpenReviewItem",
         c.permalink, c.is_own_account AS "isOwnAccount"
    FROM comment c
    JOIN brand b ON b.id = c.brand_id
    JOIN connection cn ON cn.id = c.connection_id
    LEFT JOIN author a ON a.id = c.author_id
   WHERE c.organization_id = $1
     AND b.archived_at IS NULL
     AND c.platform_state <> 'deleted'
     AND cn.platform IN ('facebook', 'instagram')`;

export async function listPublicComments(
  db: Db,
  org: string,
  f: CommentFilters,
  page: CommentPage,
): Promise<{ rows: CommentRow[]; next: { t: Date; id: string } | null }> {
  const params: unknown[] = [org];
  const where: string[] = [];
  const bind = (value: unknown) => `$${params.push(value)}`;
  if (f.brandId) where.push(`c.brand_id = ${bind(f.brandId)}`);
  if (f.postedFrom) where.push(`c.posted_at >= ${bind(f.postedFrom)}`);
  if (f.postedTo) where.push(`c.posted_at < ${bind(f.postedTo)}`);
  if (f.status === 'hidden') where.push(`c.platform_state = 'hidden'`);
  if (f.status === 'visible')
    where.push(`c.platform_state = 'visible' AND NOT ${OPEN_REVIEW_ITEM}`);
  if (f.status === 'flagged') where.push(`c.platform_state = 'visible' AND ${OPEN_REVIEW_ITEM}`);
  if (page.after)
    where.push(`(c.posted_at, c.id) < (${bind(page.after.t)}, ${bind(page.after.id)})`);
  const { rows } = await db.query<CommentRow>(
    `${SELECT}${where.map((w) => `\n     AND ${w}`).join('')}
   ORDER BY c.posted_at DESC, c.id DESC
   LIMIT ${bind(page.limit + 1)}`,
    params,
  );
  const more = rows.length > page.limit;
  const kept = rows.slice(0, page.limit);
  const last = kept.at(-1);
  return { rows: kept, next: more && last ? { t: last.postedAt, id: last.id } : null };
}

export async function loadPublicComment(
  db: Db,
  org: string,
  commentId: string,
): Promise<CommentRow | null> {
  const { rows } = await db.query<CommentRow>(`${SELECT}\n     AND c.id = $2`, [org, commentId]);
  return rows[0] ?? null;
}

export async function loadPublicCommentsByIds(
  db: Db,
  org: string,
  ids: readonly string[],
): Promise<Map<string, CommentRow>> {
  const { rows } = await db.query<CommentRow>(`${SELECT}\n     AND c.id = ANY($2::uuid[])`, [
    org,
    ids,
  ]);
  return new Map(rows.map((r) => [r.id, r]));
}
