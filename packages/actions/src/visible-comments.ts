// Read model for the workspace-wide comments list: every visible comment of every live connection in
// an organization's non-archived brands. Every statement is parameterised, filters organization_id
// on every join (plus brand_id where tables carry it), and returns bodies and names for display
// only: never log them.
import type pg from 'pg';
import { COMMENT_IS_AD_SQL } from '@feedbouncer/comments';
import { type ConnectionStatus, type Platform, type PlatformState } from '@feedbouncer/connectors';
import {
  CATEGORY_SLUG,
  COMMENT_STATUSES,
  LISTABLE_PLATFORMS,
  type CommentStatus,
} from './comment-status.js';

export { CATEGORY_SLUG, COMMENT_STATUSES, LISTABLE_PLATFORMS, type CommentStatus };
/** Filter sentinels: not on an ad / no category. `_` cannot start a category slug. */
export const NO_AD = 'none';
export const UNCATEGORIZED = '_none';

export const QUEUES = ['open', 'done', 'all'] as const;
export type Queue = (typeof QUEUES)[number];

export interface VisibleCommentFilter {
  platform: Platform | null;
  adId: string | typeof NO_AD | null;
  category: string | typeof UNCATEGORIZED | null;
  status: CommentStatus | null;
  queue: Queue;
  tagIds: string[];
}
export interface VisibleCommentCursor {
  postedAt: Date;
  id: string;
}
export interface VisibleCommentAd {
  adId: string;
  externalId: string;
  name: string | null;
  deleted: boolean;
}
export type AccountProblem = 'reconnect_required' | 'sync_failing';

export interface CommentReply {
  id: string;
  text: string;
  status: 'pending' | 'applied';
  actorType: string;
  authorName: string | null;
  createdAt: Date;
  completedAt: Date | null;
}
export interface ReplyTarget {
  connectionStatus: ConnectionStatus;
  hasAuthor: boolean;
  parentExternalId: string | null;
  targetPlatformState: PlatformState | null;
}

export interface VisibleComment {
  id: string;
  brandId: string;
  brandName: string;
  connectionId: string;
  connectionName: string | null;
  platform: Platform;
  authorName: string | null;
  body: string;
  postedAt: Date;
  permalink: string | null;
  isReply: boolean;
  ads: VisibleCommentAd[];
  adCount: number;
  category: string | null;
  status: CommentStatus;
  stale: boolean;
  done: { at: Date; byName: string | null } | null;
  tags: { id: string; name: string }[];
  replies: CommentReply[];
  replyCount: number;
  replyTarget: ReplyTarget;
}
export interface AdOption extends VisibleCommentAd {
  adAccountExternalId: string;
  brandName: string;
  platforms: ('facebook' | 'instagram')[];
}
export interface FilterOptions {
  platforms: Platform[];
  ads: AdOption[];
  adsTruncated: boolean;
  categories: string[];
  statuses: readonly CommentStatus[];
  tags: { id: string; name: string }[];
}
export interface AccountHealth {
  connectionId: string;
  brandId: string;
  brandName: string;
  platform: Platform;
  displayName: string | null;
  problem: AccountProblem | null;
  lastSyncedAt: Date | null;
}

const SYNC_FAILURES = 3;
const AD_OPTIONS_LIMIT = 500;
const ADS_PER_ROW = 5;
const REPLIES_PER_ROW = 3;

/** Mirrors ACCOUNT_PROBLEM_SQL; a test pins the two together. */
export function accountProblem(a: {
  status: ConnectionStatus;
  lastErrorClass: string | null;
  consecutiveFailures: number;
  lastFailureAt: Date | null;
  lastSuccessAt: Date | null;
}): AccountProblem | null {
  if (a.status === 'reconnect_required' || a.status === 'error') return 'reconnect_required';
  if (a.lastErrorClass === 'needs_reconnection') return 'reconnect_required';
  if (
    a.consecutiveFailures >= SYNC_FAILURES &&
    a.lastFailureAt &&
    (!a.lastSuccessAt || a.lastFailureAt > a.lastSuccessAt)
  )
    return 'sync_failing';
  return null;
}

// Over `connection cn` and `connection_sync cs` (left joined).
const ACCOUNT_PROBLEM_SQL = `(CASE
  WHEN cn.status IN ('reconnect_required', 'error') OR cs.last_error_class = 'needs_reconnection'
    THEN 'reconnect_required'
  WHEN cs.consecutive_failures >= ${SYNC_FAILURES}
       AND cs.last_failure_at > COALESCE(cs.last_success_at, '-infinity'::timestamptz)
    THEN 'sync_failing'
END)`;

const SYNC_JOIN = `LEFT JOIN connection_sync cs ON cs.organization_id = cn.organization_id
                                              AND cs.brand_id = cn.brand_id AND cs.connection_id = cn.id`;

// Over `comment c`, `connection cn`, `brand b`; $1 is the organization.
const LISTABLE_SQL = `c.organization_id = $1 AND c.platform_state = 'visible' AND NOT c.is_own_account
  AND cn.status <> 'revoked' AND b.archived_at IS NULL`;

const LISTABLE_FROM = `comment c
  JOIN connection cn ON cn.organization_id = c.organization_id AND cn.brand_id = c.brand_id
                    AND cn.id = c.connection_id
  JOIN brand b ON b.organization_id = c.organization_id AND b.id = c.brand_id`;

// The newest non-null category of the comment.
const CATEGORY_SQL = `(SELECT d.category FROM decision d
   WHERE d.organization_id = c.organization_id AND d.brand_id = c.brand_id AND d.comment_id = c.id
     AND d.category IS NOT NULL
   ORDER BY d.sequence DESC LIMIT 1)`;

const exists = (table: string, cond: string) =>
  `EXISTS (SELECT 1 FROM ${table} x WHERE x.organization_id = c.organization_id
     AND x.brand_id = c.brand_id AND x.comment_id = c.id AND ${cond})`;

// First match wins: flagged, awaiting_action, reviewed, else new.
const STATUS_SQL = `(CASE
  WHEN ${exists('review_item', "x.status = 'open'")} THEN 'flagged'
  WHEN ${exists('action_suggestion', "x.status = 'pending'")}
    OR ${exists('moderation_action', "x.status = 'pending'")} THEN 'awaiting_action'
  WHEN ${exists('review_item', "x.status = 'resolved'")}
    OR ${exists('action_suggestion', "x.status IN ('approved', 'dismissed')")}
    OR ${exists('decision', "x.actor_type = 'user'")}
    OR ${exists('moderation_action', "x.actor_type = 'user'")} THEN 'reviewed'
  ELSE 'new'
END)`;

// At most ADS_PER_ROW ads plus the total, aggregated per comment so rows never multiply.
const ADS_SQL = `LEFT JOIN LATERAL (
  SELECT count(*)::int AS ad_count,
         COALESCE(jsonb_agg(jsonb_build_object('adId', x.id, 'externalId', x.external_id, 'name', x.name,
                                               'deleted', x.deleted_at IS NOT NULL) ORDER BY x.rn)
                  FILTER (WHERE x.rn <= ${ADS_PER_ROW}), '[]'::jsonb) AS ads
    FROM (SELECT ma.id, ma.external_id, ma.name, ma.deleted_at,
                 row_number() OVER (ORDER BY lower(ma.name) NULLS LAST, ma.external_id) AS rn
            FROM meta_ad ma
           WHERE ma.organization_id = c.organization_id AND ma.brand_id = c.brand_id
             AND ma.id IN (SELECT mas.ad_id FROM meta_ad_source mas
                            WHERE mas.organization_id = c.organization_id AND mas.brand_id = c.brand_id
                              AND mas.source_id IN (c.source_id, c.ad_source_id))) x) ad ON true`;

// Done state of the comment; over `comment c`.
const DONE_EXISTS_SQL = `EXISTS (SELECT 1 FROM comment_done d
   WHERE d.organization_id = c.organization_id AND d.brand_id = c.brand_id AND d.comment_id = c.id)`;

// Per-row triage and reply details, joined to the page only. `p` is the parent comment.
const ROW_DETAIL_SQL = `LEFT JOIN comment_done dn ON dn.organization_id = c.organization_id
                                                  AND dn.brand_id = c.brand_id AND dn.comment_id = c.id
  LEFT JOIN app_user du ON du.id = dn.done_by_user_id
  LEFT JOIN comment p ON p.organization_id = c.organization_id AND p.brand_id = c.brand_id
                     AND p.id = c.parent_comment_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name)
                              ORDER BY lower(t.name), t.id), '[]'::jsonb) AS tags
      FROM comment_tag ct
      JOIN tag t ON t.organization_id = ct.organization_id AND t.id = ct.tag_id
     WHERE ct.organization_id = c.organization_id AND ct.brand_id = c.brand_id
       AND ct.comment_id = c.id) tg ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS reply_count,
           COALESCE(jsonb_agg(jsonb_build_object('id', x.id, 'text', x.reply_text, 'status', x.status,
                                                 'actorType', x.actor_type, 'authorName', x.author_name,
                                                 'createdAt', x.created_at, 'completedAt', x.completed_at)
                              ORDER BY x.rn) FILTER (WHERE x.rn <= ${REPLIES_PER_ROW}), '[]'::jsonb) AS replies
      FROM (SELECT ma.id, ma.reply_text, ma.status, ma.actor_type, ma.created_at, ma.completed_at,
                   CASE WHEN ma.actor_type = 'user' THEN ru.display_name END AS author_name,
                   row_number() OVER (ORDER BY ma.created_at DESC, ma.id DESC) AS rn
              FROM moderation_action ma
              LEFT JOIN app_user ru ON ru.id = ma.actor_user_id
             WHERE ma.organization_id = c.organization_id AND ma.brand_id = c.brand_id
               AND ma.comment_id = c.id AND ma.kind = 'public_reply'
               AND ma.status IN ('pending', 'applied')) x) rp ON true`;

/** The shared WHERE: values start with the organization; every filter value is a bind parameter. */
function whereSql(f: VisibleCommentFilter): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const bind = (v: unknown) => `$${values.push(v) + 1}`;
  const parts = [LISTABLE_SQL];
  if (f.platform) parts.push(`cn.platform = ${bind(f.platform)}::text`);
  if (f.adId === NO_AD) parts.push(`NOT ${COMMENT_IS_AD_SQL}`);
  else if (f.adId)
    parts.push(`EXISTS (SELECT 1 FROM meta_ad_source mas
       WHERE mas.organization_id = c.organization_id AND mas.brand_id = c.brand_id
         AND mas.ad_id = ${bind(f.adId)}::uuid AND mas.source_id IN (c.source_id, c.ad_source_id))`);
  if (f.category === UNCATEGORIZED) parts.push(`${CATEGORY_SQL} IS NULL`);
  else if (f.category) parts.push(`${CATEGORY_SQL} = ${bind(f.category)}::text`);
  if (f.status) parts.push(`${STATUS_SQL} = ${bind(f.status)}::text`);
  if (f.queue === 'open') parts.push(`NOT ${DONE_EXISTS_SQL}`);
  else if (f.queue === 'done') parts.push(DONE_EXISTS_SQL);
  for (const tagId of f.tagIds)
    parts.push(`EXISTS (SELECT 1 FROM comment_tag ct
       WHERE ct.organization_id = c.organization_id AND ct.brand_id = c.brand_id
         AND ct.comment_id = c.id AND ct.tag_id = ${bind(tagId)}::uuid)`);
  return { sql: parts.join('\n  AND '), values };
}

const LIST_COLUMNS = `c.id, c.brand_id, b.name AS brand_name, c.connection_id, cn.display_name AS connection_name,
       cn.platform, au.display_name AS author_name, c.body, c.posted_at, c.permalink,
       (c.parent_comment_id IS NOT NULL OR c.parent_external_id IS NOT NULL) AS is_reply,
       ad.ads, ad.ad_count, ${CATEGORY_SQL} AS category, ${STATUS_SQL} AS status,
       ${ACCOUNT_PROBLEM_SQL} IS NOT NULL AS stale,
       dn.done_at, du.display_name AS done_by_name, tg.tags, rp.replies, rp.reply_count,
       cn.status AS connection_status, c.author_id IS NOT NULL AS has_author, c.parent_external_id,
       CASE WHEN c.parent_external_id IS NOT NULL THEN p.platform_state ELSE c.platform_state END
         AS target_platform_state`;

/** The statement and parameters behind a page of `list`, for query-plan checks. */
export function visibleListQuery(
  orgId: string,
  f: VisibleCommentFilter,
  page: { before: VisibleCommentCursor | null; limit: number },
) {
  const w = whereSql(f);
  const values = [orgId, ...w.values];
  const bind = (v: unknown) => `$${values.push(v)}`;
  const cursor = page.before
    ? `AND (c.posted_at, c.id) < (${bind(page.before.postedAt)}::timestamptz, ${bind(page.before.id)}::uuid)`
    : '';
  // The page is picked first, so the per-row details run for one page only. OFFSET 0 keeps the planner
  // from joining connection and brand first: it walks the visible-comment index in order and stops at the limit.
  const text = `
SELECT ${LIST_COLUMNS}
  FROM (SELECT c.* FROM comment c
          JOIN LATERAL (SELECT cn.platform, cn.status FROM connection cn
                         WHERE cn.organization_id = c.organization_id AND cn.brand_id = c.brand_id
                           AND cn.id = c.connection_id OFFSET 0) cn ON true
          JOIN LATERAL (SELECT b.archived_at FROM brand b
                         WHERE b.organization_id = c.organization_id AND b.id = c.brand_id OFFSET 0) b ON true
         WHERE ${w.sql} ${cursor}
         ORDER BY c.posted_at DESC, c.id DESC
         LIMIT ${bind(page.limit + 1)}) c
  JOIN connection cn ON cn.organization_id = c.organization_id AND cn.brand_id = c.brand_id
                    AND cn.id = c.connection_id
  JOIN brand b ON b.organization_id = c.organization_id AND b.id = c.brand_id
  ${SYNC_JOIN}
  LEFT JOIN author au ON au.organization_id = c.organization_id AND au.brand_id = c.brand_id
                     AND au.connection_id = c.connection_id AND au.id = c.author_id
  ${ADS_SQL}
  ${ROW_DETAIL_SQL}
 ORDER BY c.posted_at DESC, c.id DESC`;
  return { text, values };
}

/** The statement and parameters behind `list`'s total. */
export function visibleCountQuery(orgId: string, f: VisibleCommentFilter) {
  const w = whereSql(f);
  return {
    text: `SELECT count(*)::int AS total FROM ${LISTABLE_FROM} WHERE ${w.sql}`,
    values: [orgId, ...w.values],
  };
}

interface Row {
  id: string;
  brand_id: string;
  brand_name: string;
  connection_id: string;
  connection_name: string | null;
  platform: Platform;
  author_name: string | null;
  body: string;
  posted_at: Date;
  permalink: string | null;
  is_reply: boolean;
  ads: VisibleCommentAd[];
  ad_count: number | null;
  category: string | null;
  status: CommentStatus;
  stale: boolean;
  done_at: Date | null;
  done_by_name: string | null;
  tags: { id: string; name: string }[];
  replies: (Omit<CommentReply, 'createdAt' | 'completedAt'> & {
    createdAt: string;
    completedAt: string | null;
  })[];
  reply_count: number | null;
  connection_status: ConnectionStatus;
  has_author: boolean;
  parent_external_id: string | null;
  target_platform_state: PlatformState | null;
}

const toComment = (r: Row): VisibleComment => ({
  id: r.id,
  brandId: r.brand_id,
  brandName: r.brand_name,
  connectionId: r.connection_id,
  connectionName: r.connection_name,
  platform: r.platform,
  authorName: r.author_name,
  body: r.body,
  postedAt: r.posted_at,
  permalink: r.permalink,
  isReply: r.is_reply,
  ads: r.ads,
  adCount: r.ad_count ?? 0,
  category: r.category,
  status: r.status,
  stale: r.stale,
  done: r.done_at ? { at: r.done_at, byName: r.done_by_name } : null,
  tags: r.tags,
  replies: r.replies.map((x) => ({
    ...x,
    createdAt: new Date(x.createdAt),
    completedAt: x.completedAt ? new Date(x.completedAt) : null,
  })),
  replyCount: r.reply_count ?? 0,
  replyTarget: {
    connectionStatus: r.connection_status,
    hasAuthor: r.has_author,
    parentExternalId: r.parent_external_id,
    targetPlatformState: r.target_platform_state,
  },
});

// $1 = organization. Ads that have a listable comment through any link, unlinked or not.
const AD_OPTIONS_SQL = `
SELECT ma.id, ma.external_id, ma.name, ma.deleted_at, ma.ad_account_external_id, ab.name AS brand_name,
       (SELECT array_agg(DISTINCT p.platform ORDER BY p.platform)
          FROM meta_ad_source p
         WHERE p.organization_id = ma.organization_id AND p.brand_id = ma.brand_id AND p.ad_id = ma.id) AS platforms
  FROM meta_ad ma
  JOIN brand ab ON ab.organization_id = ma.organization_id AND ab.id = ma.brand_id
 WHERE ma.organization_id = $1 AND ${adHasListable('ma.id')}
 ORDER BY lower(ma.name) NULLS LAST, ma.external_id
 LIMIT ${AD_OPTIONS_LIMIT + 1}`;

function adHasListable(adId: string): string {
  return `EXISTS (SELECT 1
     FROM meta_ad_source mas
     JOIN ${LISTABLE_FROM} ON c.organization_id = mas.organization_id AND c.brand_id = mas.brand_id
                          AND mas.source_id IN (c.source_id, c.ad_source_id)
    WHERE mas.organization_id = $1 AND mas.ad_id = ${adId} AND ${LISTABLE_SQL})`;
}

const PLATFORM_OPTIONS_SQL = `
SELECT DISTINCT cn.platform
  FROM connection cn
  JOIN brand b ON b.organization_id = cn.organization_id AND b.id = cn.brand_id
 WHERE cn.organization_id = $1 AND cn.status <> 'revoked' AND cn.platform <> 'meta_ads'
   AND b.archived_at IS NULL
 ORDER BY cn.platform`;

const CATEGORY_OPTIONS_SQL = `
SELECT cat FROM (
  SELECT DISTINCT ${CATEGORY_SQL} AS cat FROM ${LISTABLE_FROM} WHERE ${LISTABLE_SQL}) x
 WHERE cat IS NOT NULL ORDER BY cat`;

const TAG_OPTIONS_SQL = `
SELECT id, name FROM tag WHERE organization_id = $1 ORDER BY lower(name), id`;

const ACCOUNTS_SQL = `
SELECT cn.id, cn.brand_id, b.name AS brand_name, cn.platform, cn.display_name,
       ${ACCOUNT_PROBLEM_SQL} AS problem, cs.last_success_at
  FROM connection cn
  JOIN brand b ON b.organization_id = cn.organization_id AND b.id = cn.brand_id
  ${SYNC_JOIN}
 WHERE cn.organization_id = $1 AND cn.status <> 'revoked' AND cn.platform <> 'meta_ads'
   AND b.archived_at IS NULL
 ORDER BY b.name, cn.platform, cn.id`;

export class PgVisibleComments {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    orgId: string,
    f: VisibleCommentFilter,
    page: { before: VisibleCommentCursor | null; limit: number },
  ): Promise<{ items: VisibleComment[]; next: VisibleCommentCursor | null; total: number }> {
    const l = visibleListQuery(orgId, f, page);
    const k = visibleCountQuery(orgId, f);
    const [rows, count] = await Promise.all([
      this.pool.query<Row>(l.text, l.values),
      this.pool.query<{ total: number }>(k.text, k.values),
    ]);
    const items = rows.rows.slice(0, page.limit).map(toComment);
    const last = items.at(-1);
    return {
      items,
      next: rows.rows.length > page.limit && last ? { postedAt: last.postedAt, id: last.id } : null,
      total: count.rows[0]!.total,
    };
  }

  async options(orgId: string): Promise<FilterOptions> {
    const [platforms, ads, categories, tags] = await Promise.all([
      this.pool.query<{ platform: Platform }>(PLATFORM_OPTIONS_SQL, [orgId]),
      this.pool.query<{
        id: string;
        external_id: string;
        name: string | null;
        deleted_at: Date | null;
        ad_account_external_id: string;
        brand_name: string;
        platforms: AdOption['platforms'] | null;
      }>(AD_OPTIONS_SQL, [orgId]),
      this.pool.query<{ cat: string }>(CATEGORY_OPTIONS_SQL, [orgId]),
      this.pool.query<{ id: string; name: string }>(TAG_OPTIONS_SQL, [orgId]),
    ]);
    return {
      platforms: platforms.rows.map((r) => r.platform),
      ads: ads.rows.slice(0, AD_OPTIONS_LIMIT).map((r) => ({
        adId: r.id,
        externalId: r.external_id,
        name: r.name,
        deleted: r.deleted_at !== null,
        adAccountExternalId: r.ad_account_external_id,
        brandName: r.brand_name,
        platforms: r.platforms ?? [],
      })),
      adsTruncated: ads.rows.length > AD_OPTIONS_LIMIT,
      categories: categories.rows.map((r) => r.cat),
      statuses: COMMENT_STATUSES,
      tags: tags.rows,
    };
  }

  async accounts(orgId: string): Promise<AccountHealth[]> {
    const { rows } = await this.pool.query<{
      id: string;
      brand_id: string;
      brand_name: string;
      platform: Platform;
      display_name: string | null;
      problem: AccountProblem | null;
      last_success_at: Date | null;
    }>(ACCOUNTS_SQL, [orgId]);
    return rows.map((r) => ({
      connectionId: r.id,
      brandId: r.brand_id,
      brandName: r.brand_name,
      platform: r.platform,
      displayName: r.display_name,
      problem: r.problem,
      lastSyncedAt: r.last_success_at,
    }));
  }

  /** Drops filter values that are not valid for this org, so a stale or foreign value never applies. */
  async applicable(orgId: string, f: VisibleCommentFilter): Promise<VisibleCommentFilter> {
    const [platformOk, categoryOk, adOk, tagIds] = await Promise.all([
      f.platform ? this.platformApplies(orgId, f.platform) : true,
      f.category && f.category !== UNCATEGORIZED ? this.categoryApplies(orgId, f.category) : true,
      f.adId && f.adId !== NO_AD ? this.adApplies(orgId, f.adId) : true,
      this.tagsApply(orgId, f.tagIds),
    ]);
    const platform = platformOk ? f.platform : null;
    const category = categoryOk ? f.category : null;
    const adId = adOk ? f.adId : null;
    return { platform, category, status: f.status, adId, queue: f.queue, tagIds };
  }

  private async tagsApply(orgId: string, tagIds: string[]): Promise<string[]> {
    const wanted = [...new Set(tagIds)];
    if (wanted.length === 0) return [];
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM tag WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [orgId, wanted],
    );
    const known = new Set(rows.map((r) => r.id));
    return wanted.filter((id) => known.has(id));
  }

  private async platformApplies(orgId: string, platform: Platform): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM connection cn
         JOIN brand b ON b.organization_id = cn.organization_id AND b.id = cn.brand_id
        WHERE cn.organization_id = $1 AND cn.platform = $2 AND cn.platform <> 'meta_ads'
          AND cn.status <> 'revoked' AND b.archived_at IS NULL LIMIT 1`,
      [orgId, platform],
    );
    return rows.length > 0;
  }

  private async categoryApplies(orgId: string, category: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM ${LISTABLE_FROM} WHERE ${LISTABLE_SQL} AND ${CATEGORY_SQL} = $2 LIMIT 1`,
      [orgId, category],
    );
    return rows.length > 0;
  }

  private async adApplies(orgId: string, adId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM meta_ad ma WHERE ma.organization_id = $1 AND ma.id = $2::uuid AND ${adHasListable('ma.id')}`,
      [orgId, adId],
    );
    return rows.length > 0;
  }
}
