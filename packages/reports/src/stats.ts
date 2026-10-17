// Weekly metrics read model: one snapshot of a workspace's week, shared by the email and the
// Weekly report page. Every statement binds organization_id = $1 and never reads comment text.
import type pg from 'pg';
import { TOP_ADS_MIN_COMMENTS } from './constants.js';
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
  /** Brands with processed > 0, by name. */
  brands: BrandStat[];
  incompleteAccounts: { connectionId: string; name: string; platform: string }[];
}

/** Upper bound on candidate ads handed to ranking. */
const ADS_CANDIDATES = 200;

// $1 org, $2 start, $3 end.
const TOTALS_SQL = `
WITH ${WEEK_COMMENTS_CTES},
by_brand AS (
  SELECT w.brand_id, count(*)::int AS processed, count(w.bucket)::int AS hidden
    FROM week w
   GROUP BY w.brand_id)
SELECT (SELECT count(*)::int FROM week) AS processed,
       (SELECT count(bucket)::int FROM week) AS hidden,
       (SELECT COALESCE(json_object_agg(x.bucket, x.n), '{}')
          FROM (SELECT bucket, count(*)::int AS n FROM week WHERE bucket IS NOT NULL GROUP BY bucket) x
       ) AS buckets,
       (SELECT COALESCE(json_agg(json_build_object(
                 'brandId', b.id, 'name', b.name, 'archived', b.archived_at IS NOT NULL,
                 'processed', x.processed, 'hidden', x.hidden) ORDER BY b.name, b.id), '[]')
          FROM by_brand x
          JOIN brand b ON b.organization_id = $1 AND b.id = x.brand_id) AS brands`;

// $1 org, $2 previous week start, $3 week start.
const PROCESSED_SQL = `
SELECT count(*)::int AS processed
  FROM comment c
 WHERE c.organization_id = $1 AND NOT c.is_own_account
   AND c.posted_at >= $2 AND c.posted_at < $3 AND ${PROCESSED_COMMENT_SQL}`;

// $1 org, $2 start, $3 end, $4 minimum comments. A comment counts once per ad even when both its
// source and its ad source link to that ad. Links count even if since unlinked: the week's data
// stands. Pre-ordered by hidden share so the cap never drops an ad ranking would pick.
const ADS_SQL = `
WITH ${WEEK_COMMENTS_CTES},
per_ad AS (
  SELECT mas.brand_id, mas.ad_id,
         array_agg(DISTINCT mas.platform ORDER BY mas.platform) AS platforms,
         count(DISTINCT w.id)::int AS total,
         (count(DISTINCT w.id) FILTER (WHERE w.bucket IS NOT NULL))::int AS hidden
    FROM week w
    JOIN meta_ad_source mas ON mas.organization_id = $1 AND mas.brand_id = w.brand_id
                           AND mas.source_id IN (w.source_id, w.ad_source_id)
   GROUP BY mas.brand_id, mas.ad_id)
SELECT ma.id, ma.external_id, ma.name, x.platforms, ma.brand_id, x.hidden, x.total,
       (ma.deleted_at IS NOT NULL OR ma.effective_status IN ('ARCHIVED', 'DELETED')
        OR b.archived_at IS NOT NULL) AS archived
  FROM per_ad x
  JOIN meta_ad ma ON ma.organization_id = $1 AND ma.brand_id = x.brand_id AND ma.id = x.ad_id
  JOIN brand b ON b.organization_id = $1 AND b.id = x.brand_id
 WHERE x.total >= $4 AND x.hidden > 0
 ORDER BY x.hidden::numeric / x.total DESC, x.hidden DESC, ma.id
 LIMIT ${ADS_CANDIDATES}`;

// $1 org, $2 week start, $3 computedAt.
const INCOMPLETE_SQL = `
SELECT cn.id, COALESCE(cn.display_name, cn.external_account_id) AS name, cn.platform
  FROM connection cn
 WHERE cn.organization_id = $1
   AND (cn.status IN ('revoked', 'error', 'reconnect_required')
        OR EXISTS (SELECT 1 FROM audit_event e
                    WHERE e.organization_id = $1 AND e.subject_type = 'connection' AND e.subject_id = cn.id
                      AND e.action IN ('connection.disconnected', 'connection.reconnect_required')
                      AND e.created_at >= $2 AND e.created_at < $3))
 ORDER BY name, cn.id`;

interface TotalsRow {
  processed: number;
  hidden: number;
  buckets: Partial<Record<ReportBucket, number>>;
  brands: BrandStat[];
}

interface AdRow {
  id: string;
  external_id: string;
  name: string | null;
  platforms: AdStat['platforms'];
  brand_id: string;
  hidden: number;
  total: number;
  archived: boolean;
}

/** All queries bind organization_id = orgId on every table and join on (organization_id, brand_id). Never selects comment text. */
export async function computeWeeklyStats(
  c: pg.ClientBase,
  orgId: string,
  p: ReportPeriod,
  now: Date,
): Promise<WeeklyStats> {
  const totals = (await c.query<TotalsRow>(TOTALS_SQL, [orgId, p.start, p.end])).rows[0]!;
  const prev = await c.query<{ processed: number }>(PROCESSED_SQL, [orgId, p.prevStart, p.start]);
  const ads = await c.query<AdRow>(ADS_SQL, [orgId, p.start, p.end, TOP_ADS_MIN_COMMENTS]);
  const incomplete = await c.query<{ id: string; name: string; platform: string }>(
    INCOMPLETE_SQL,
    [orgId, p.start, now],
  );
  return {
    version: 1,
    organizationId: orgId,
    weekStart: p.weekStart,
    timezone: p.timezone,
    start: p.start.toISOString(),
    end: p.end.toISOString(),
    computedAt: now.toISOString(),
    processed: totals.processed,
    processedPrev: prev.rows[0]!.processed,
    hidden: totals.hidden,
    buckets: REPORT_BUCKETS.flatMap((bucket) => {
      const count = totals.buckets[bucket] ?? 0;
      return count > 0 ? [{ bucket, count }] : [];
    }),
    ads: ads.rows.map((r) => ({
      adId: r.id,
      externalId: r.external_id,
      name: r.name,
      platforms: r.platforms,
      brandId: r.brand_id,
      archived: r.archived,
      hidden: r.hidden,
      total: r.total,
    })),
    brands: totals.brands,
    incompleteAccounts: incomplete.rows.map((r) => ({
      connectionId: r.id,
      name: r.name,
      platform: r.platform,
    })),
  };
}
