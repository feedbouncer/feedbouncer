// Weekly metrics read model: one snapshot of a workspace's week, shared by the email and the
// Weekly report page. Every statement binds organization_id = $1 and never reads comment text.
import type pg from 'pg';
import {
  REPORT_BRANDS_MAX,
  REPORT_INCOMPLETE_ACCOUNTS_MAX,
  TOP_ADS_MIN_COMMENTS,
} from './constants.js';
import type { ReportPeriod } from './period.js';
import {
  PROCESSED_COMMENT_SQL,
  REPORT_BUCKETS,
  WEEK_COMMENTS_CTES,
  type ReportBucket,
} from './sql.js';

export interface AdStat {
  adId: string;
  externalId: string;
  name: string | null;
  platforms: ('facebook' | 'instagram')[];
  brandId: string;
  archived: boolean;
  hidden: number;
  total: number;
}

export interface BrandStat {
  brandId: string;
  name: string;
  archived: boolean;
  processed: number;
  hidden: number;
}

export interface WeeklyStats {
  version: 1;
  organizationId: string;
  weekStart: string;
  timezone: string;
  start: string;
  end: string;
  computedAt: string;
  processed: number;
  processedPrev: number;
  hidden: number;
  /** count > 0 only, in REPORT_BUCKETS order; the counts sum to `hidden`. */
  buckets: { bucket: ReportBucket; count: number }[];
  /** Every ad with total ≥ TOP_ADS_MIN_COMMENTS and hidden > 0 (at most ADS_CANDIDATES), unranked. */
  ads: AdStat[];
  /** The REPORT_BRANDS_MAX brands with the most processed comments (processed > 0), by name. */
  brands: BrandStat[];
  /** Every brand with processed > 0, including those cut from `brands`. */
  brandCount: number;
  /** The first REPORT_INCOMPLETE_ACCOUNTS_MAX by name. */
  incompleteAccounts: { connectionId: string; name: string; platform: string }[];
  /** Every incomplete account, including those cut from `incompleteAccounts`. */
  incompleteAccountCount: number;
}

/** Upper bound on candidate ads handed to ranking. */
const ADS_CANDIDATES = 200;

// One statement, so the hide attribution chain runs once and every metric reads one snapshot.
// $1 org, $2 start, $3 end, $4 previous week start, $5 minimum ad comments, $6 computedAt,
// $7 brands kept, $8 incomplete accounts kept.
//
// brands and incomplete accounts are capped (and counted in full) so the snapshot fits
// weekly_report's 64 KiB payload CHECK however large the workspace.
// ads: a comment counts once per ad even when both its source and its ad source link to that ad.
// Links count even if since unlinked: the week's data stands. Pre-ordered by hidden share so the
// cap never drops an ad ranking would pick.
// incomplete: a connection currently in error or reconnect_required, or one disconnected or flagged
// for reconnect in [start, computedAt). 'revoked' is a permanent end state, so it counts only
// through its audit event.
const STATS_SQL = `
WITH ${WEEK_COMMENTS_CTES},
by_brand AS (
  SELECT w.brand_id, count(*)::int AS processed, count(w.bucket)::int AS hidden
    FROM week w
   GROUP BY w.brand_id),
per_ad AS (
  SELECT mas.brand_id, mas.ad_id,
         array_agg(DISTINCT mas.platform ORDER BY mas.platform) AS platforms,
         count(DISTINCT w.id)::int AS total,
         (count(DISTINCT w.id) FILTER (WHERE w.bucket IS NOT NULL))::int AS hidden
    FROM week w
    JOIN meta_ad_source mas ON mas.organization_id = $1 AND mas.brand_id = w.brand_id
                           AND mas.source_id IN (w.source_id, w.ad_source_id)
   GROUP BY mas.brand_id, mas.ad_id),
ads AS (
  SELECT ma.id, ma.external_id, ma.name, x.platforms, ma.brand_id, x.hidden, x.total,
         (ma.deleted_at IS NOT NULL OR ma.effective_status IN ('ARCHIVED', 'DELETED')
          OR b.archived_at IS NOT NULL) AS archived
    FROM per_ad x
    JOIN meta_ad ma ON ma.organization_id = $1 AND ma.brand_id = x.brand_id AND ma.id = x.ad_id
    JOIN brand b ON b.organization_id = $1 AND b.id = x.brand_id
   WHERE x.total >= $5 AND x.hidden > 0
   ORDER BY x.hidden::numeric / x.total DESC, x.hidden DESC, ma.id
   LIMIT ${ADS_CANDIDATES}),
incomplete AS (
  SELECT cn.id, COALESCE(cn.display_name, cn.external_account_id) AS name, cn.platform
    FROM connection cn
   WHERE cn.organization_id = $1
     AND (cn.status IN ('error', 'reconnect_required')
          OR EXISTS (SELECT 1 FROM audit_event e
                      WHERE e.organization_id = $1 AND e.subject_type = 'connection' AND e.subject_id = cn.id
                        AND e.action IN ('connection.disconnected', 'connection.reconnect_required')
                        AND e.created_at >= $2 AND e.created_at < $6)))
SELECT (SELECT count(*)::int FROM week) AS processed,
       (SELECT count(bucket)::int FROM week) AS hidden,
       (SELECT count(*)::int
          FROM comment c
         WHERE c.organization_id = $1 AND NOT c.is_own_account
           AND c.posted_at >= $4 AND c.posted_at < $2 AND ${PROCESSED_COMMENT_SQL}) AS processed_prev,
       (SELECT COALESCE(json_object_agg(x.bucket, x.n), '{}')
          FROM (SELECT bucket, count(*)::int AS n FROM week WHERE bucket IS NOT NULL GROUP BY bucket) x
       ) AS buckets,
       (SELECT COALESCE(json_agg(json_build_object(
                 'brandId', t.id, 'name', t.name, 'archived', t.archived,
                 'processed', t.processed, 'hidden', t.hidden) ORDER BY t.name, t.id), '[]')
          FROM (SELECT b.id, b.name, b.archived_at IS NOT NULL AS archived, x.processed, x.hidden
                  FROM by_brand x
                  JOIN brand b ON b.organization_id = $1 AND b.id = x.brand_id
                 ORDER BY x.processed DESC, b.name, b.id
                 LIMIT $7) t) AS brands,
       (SELECT count(*)::int FROM by_brand) AS brand_count,
       (SELECT COALESCE(json_agg(json_build_object(
                 'adId', a.id, 'externalId', a.external_id, 'name', a.name, 'platforms', a.platforms,
                 'brandId', a.brand_id, 'archived', a.archived, 'hidden', a.hidden, 'total', a.total)
                 ORDER BY a.hidden::numeric / a.total DESC, a.hidden DESC, a.id), '[]')
          FROM ads a) AS ads,
       (SELECT COALESCE(json_agg(json_build_object(
                 'connectionId', i.id, 'name', i.name, 'platform', i.platform) ORDER BY i.name, i.id), '[]')
          FROM (SELECT * FROM incomplete ORDER BY name, id LIMIT $8) i) AS incomplete_accounts,
       (SELECT count(*)::int FROM incomplete) AS incomplete_account_count`;

interface StatsRow {
  processed: number;
  hidden: number;
  processed_prev: number;
  buckets: Partial<Record<ReportBucket, number>>;
  brands: BrandStat[];
  brand_count: number;
  ads: AdStat[];
  incomplete_accounts: WeeklyStats['incompleteAccounts'];
  incomplete_account_count: number;
}

/**
 * All queries bind organization_id = orgId on every table and join on (organization_id, brand_id).
 * Never selects comment text. Issues a single statement and manages no transaction, so it reads one
 * snapshot and runs inside the caller's (e.g. the scheduler's REPEATABLE READ per-org) transaction.
 */
export async function computeWeeklyStats(
  c: pg.ClientBase,
  orgId: string,
  p: ReportPeriod,
  now: Date,
): Promise<WeeklyStats> {
  const r = (
    await c.query<StatsRow>(STATS_SQL, [
      orgId,
      p.start,
      p.end,
      p.prevStart,
      TOP_ADS_MIN_COMMENTS,
      now,
      REPORT_BRANDS_MAX,
      REPORT_INCOMPLETE_ACCOUNTS_MAX,
    ])
  ).rows[0]!;
  return {
    version: 1,
    organizationId: orgId,
    weekStart: p.weekStart,
    timezone: p.timezone,
    start: p.start.toISOString(),
    end: p.end.toISOString(),
    computedAt: now.toISOString(),
    processed: r.processed,
    processedPrev: r.processed_prev,
    hidden: r.hidden,
    buckets: REPORT_BUCKETS.flatMap((bucket) => {
      const count = r.buckets[bucket] ?? 0;
      return count > 0 ? [{ bucket, count }] : [];
    }),
    ads: r.ads,
    brands: r.brands,
    brandCount: r.brand_count,
    incompleteAccounts: r.incomplete_accounts,
    incompleteAccountCount: r.incomplete_account_count,
  };
}
