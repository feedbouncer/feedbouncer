import type pg from 'pg';
import type { CommentRow } from '../resources/comment.js';
import type { FlaggedItemRow } from '../resources/flagged-item.js';
import { loadPublicComment, loadPublicCommentsByIds } from './comments.js';

export interface FlaggedItemFilters {
  status: 'open' | 'resolved';
  brandId?: string | undefined;
  createdFrom?: Date | undefined;
  createdTo?: Date | undefined;
}

export interface FlaggedItemPage {
  limit: number;
  after?: { t: Date; id: string } | undefined;
}

export type FlaggedItemWithComment = FlaggedItemRow & { comment: CommentRow | null };

type Db = pg.Pool | pg.ClientBase;

const SELECT = `
  SELECT r.id, r.brand_id AS "brandId", r.comment_id AS "commentId", r.source,
         r.rule_id AS "ruleId", r.status, r.resolution,
         r.created_at AS "createdAt", r.resolved_at AS "resolvedAt"
    FROM review_item r
    JOIN brand b ON b.id = r.brand_id
   WHERE r.organization_id = $1
     AND b.archived_at IS NULL`;

export async function listPublicFlaggedItems(
  db: Db,
  org: string,
  f: FlaggedItemFilters,
  page: FlaggedItemPage,
): Promise<{ rows: FlaggedItemWithComment[]; next: { t: Date; id: string } | null }> {
  const params: unknown[] = [org];
  const bind = (value: unknown) => `$${params.push(value)}`;
  const where = [`r.status = ${bind(f.status)}`];
  if (f.brandId) where.push(`r.brand_id = ${bind(f.brandId)}`);
  if (f.createdFrom) where.push(`r.created_at >= ${bind(f.createdFrom)}`);
  if (f.createdTo) where.push(`r.created_at < ${bind(f.createdTo)}`);
  if (page.after)
    where.push(`(r.created_at, r.id) < (${bind(page.after.t)}, ${bind(page.after.id)})`);
  const { rows } = await db.query<FlaggedItemRow>(
    `${SELECT}${where.map((w) => `\n     AND ${w}`).join('')}
   ORDER BY r.created_at DESC, r.id DESC
   LIMIT ${bind(page.limit + 1)}`,
    params,
  );
  const more = rows.length > page.limit;
  const kept = rows.slice(0, page.limit);
  const last = kept.at(-1);
  const comments = await loadPublicCommentsByIds(
    db,
    org,
    kept.map((r) => r.commentId),
  );
  return {
    rows: kept.map((r) => ({ ...r, comment: comments.get(r.commentId) ?? null })),
    next: more && last ? { t: last.createdAt, id: last.id } : null,
  };
}

export async function loadPublicFlaggedItem(
  db: Db,
  org: string,
  id: string,
): Promise<{ item: FlaggedItemRow; comment: CommentRow | null } | null> {
  const { rows } = await db.query<FlaggedItemRow>(`${SELECT}\n     AND r.id = $2`, [org, id]);
  const item = rows[0];
  if (!item) return null;
  return { item, comment: await loadPublicComment(db, org, item.commentId) };
}
