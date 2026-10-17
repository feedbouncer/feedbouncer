// Read model for the workspace-wide comments list: every visible comment of every live connection in
// an organization's non-archived brands. Every statement is parameterised, filters organization_id
// on every join (plus brand_id where tables carry it), and returns bodies and names for display
// only: never log them.
import type pg from 'pg';
import { COMMENT_IS_AD_SQL } from '@feedbouncer/comments';
import { type ConnectionStatus, type Platform } from '@feedbouncer/connectors';
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

export interface VisibleCommentFilter {
  platform: Platform | null;
  adId: string | typeof NO_AD | null;
  category: string | typeof UNCATEGORIZED | null;
  status: CommentStatus | null;
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
  return { sql: parts.join('\n  AND '), values };
}

const LIST_COLUMNS = `c.id, c.brand_id, b.name AS brand_name, c.connection_id, cn.display_name AS connection_name,
       cn.platform, au.display_name AS author_name, c.body, c.posted_at, c.permalink,
       (c.parent_comment_id IS NOT NULL OR c.parent_external_id IS NOT NULL) AS is_reply,
       ad.ads, ad.ad_count, ${CATEGORY_SQL} AS category, ${STATUS_SQL} AS status,
       ${ACCOUNT_PROBLEM_SQL} IS NOT NULL AS stale`;

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
    const [platforms, ads, categories] = await Promise.all([
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
    const [platformOk, categoryOk, adOk] = await Promise.all([
      f.platform ? this.platformApplies(orgId, f.platform) : true,
      f.category && f.category !== UNCATEGORIZED ? this.categoryApplies(orgId, f.category) : true,
      f.adId && f.adId !== NO_AD ? this.adApplies(orgId, f.adId) : true,
    ]);
    const platform = platformOk ? f.platform : null;
    const category = categoryOk ? f.category : null;
    const adId = adOk ? f.adId : null;
    return { platform, category, status: f.status, adId };
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
