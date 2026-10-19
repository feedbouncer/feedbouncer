// Period summary read model behind GET /v1/summary: counts and highlights for any date range.
// Every statement binds organization_id = $1; comment text is read only for notable threads.
import type pg from 'pg';
import { repliedSql, unansweredSql } from '@feedbouncer/comments';

export const MAX_SUMMARY_DAYS = 92;
const DEFAULT_SUMMARY_DAYS = 7;
const DAY_MS = 86_400_000;
/** How far past `now` an end time may be, to tolerate clock skew. */
const FUTURE_SKEW_MS = 5 * 60_000;
const TOP_CATEGORIES = 10;
const TOP_RULES = 5;
const NOTABLE_THREADS = 5;
const PREVIEW_CHARS = 280;

export interface SummaryRange {
  from: Date;
  to: Date;
  /** Set when the requested start was moved forward to fit MAX_SUMMARY_DAYS. */
  bounded: null | { requestedFrom: string; reason: 'max_range_92_days' };
}

/** `to` defaults to now and `from` to a week before it. Throws RangeError 'to_before_from' | 'to_in_future'. */
export function resolveSummaryRange(
  input: { from?: Date | undefined; to?: Date | undefined },
  now: Date,
): SummaryRange {
  const to = input.to ?? now;
  if (to.getTime() > now.getTime() + FUTURE_SKEW_MS) throw new RangeError('to_in_future');
  const from = input.from ?? new Date(to.getTime() - DEFAULT_SUMMARY_DAYS * DAY_MS);
  if (to < from) throw new RangeError('to_before_from');
  const earliest = new Date(to.getTime() - MAX_SUMMARY_DAYS * DAY_MS);
  if (from >= earliest) return { from, to, bounded: null };
  return {
    from: earliest,
    to,
    bounded: { requestedFrom: from.toISOString(), reason: 'max_range_92_days' },
  };
}

export interface PeriodSummary {
  totals: { comments: number; hidden: number; replied: number; unanswered: number };
  categories: { category: string; count: number }[];
  topRules: { ruleId: string; name: string; matches: number }[];
  notableThreads: {
    commentId: string;
    platform: 'facebook' | 'instagram';
    authorName: string | null;
    textPreview: string;
    replies: number;
    postedAt: string;
  }[];
}

// Comments of archived brands are left out, as in the public comment list.
const BRAND_JOIN = `JOIN brand b ON b.organization_id = c.organization_id AND b.id = c.brand_id
                  AND b.archived_at IS NULL`;

// $1 org, $2 from, $3 to, $4 brand (null: all brands). Other people's comments in [from, to).
const IN_SCOPE = `c.organization_id = $1 AND NOT c.is_own_account AND c.platform_state <> 'deleted'
  AND c.posted_at >= $2 AND c.posted_at < $3 AND ($4::uuid IS NULL OR c.brand_id = $4)`;

const TOTALS_SQL = `
SELECT count(*)::int AS comments,
       (count(*) FILTER (WHERE c.platform_state = 'hidden'))::int AS hidden,
       (count(*) FILTER (WHERE ${repliedSql('c')}))::int AS replied,
       (count(*) FILTER (WHERE ${unansweredSql('c')}))::int AS unanswered
  FROM comment c
  ${BRAND_JOIN}
 WHERE ${IN_SCOPE}`;

// A comment counts once per category, however many decisions name it.
const CATEGORIES_SQL = `
SELECT d.category, count(DISTINCT c.id)::int AS count
  FROM comment c
  ${BRAND_JOIN}
  JOIN decision d ON d.organization_id = c.organization_id AND d.brand_id = c.brand_id
                 AND d.comment_id = c.id AND d.actor_type = 'classifier'
                 AND d.outcome <> 'approve' AND d.category IS NOT NULL
 WHERE ${IN_SCOPE}
 GROUP BY d.category
 ORDER BY count DESC, d.category
 LIMIT ${TOP_CATEGORIES}`;

const RULES_SQL = `
SELECT r.id AS "ruleId", r.name, count(DISTINCT c.id)::int AS matches
  FROM comment c
  ${BRAND_JOIN}
  JOIN decision d ON d.organization_id = c.organization_id AND d.brand_id = c.brand_id
                 AND d.comment_id = c.id AND d.rule_id IS NOT NULL
  JOIN rule r ON r.organization_id = c.organization_id AND r.brand_id = d.brand_id AND r.id = d.rule_id
 WHERE ${IN_SCOPE}
 GROUP BY r.id, r.name
 ORDER BY matches DESC, r.name, r.id
 LIMIT ${TOP_RULES}`;

const THREADS_SQL = `
SELECT c.id AS "commentId", cn.platform,
       CASE WHEN a.anonymized_at IS NULL THEN a.display_name END AS "authorName",
       left(c.body, ${PREVIEW_CHARS}) AS "textPreview",
       count(k.id)::int AS replies, c.posted_at AS "postedAt"
  FROM comment c
  ${BRAND_JOIN}
  JOIN connection cn ON cn.organization_id = c.organization_id AND cn.id = c.connection_id
  LEFT JOIN author a ON a.organization_id = c.organization_id AND a.id = c.author_id
  LEFT JOIN comment k ON k.organization_id = c.organization_id AND k.parent_comment_id = c.id
                     AND k.platform_state <> 'deleted'
 WHERE ${IN_SCOPE} AND c.parent_comment_id IS NULL
 GROUP BY c.id, cn.platform, a.anonymized_at, a.display_name
 ORDER BY replies DESC, c.posted_at DESC, c.id
 LIMIT ${NOTABLE_THREADS}`;

/** Run inside one transaction (repeatable read) so the four reads agree. */
export async function computePeriodSummary(
  c: pg.ClientBase,
  orgId: string,
  q: { from: Date; to: Date; brandId?: string | undefined },
): Promise<PeriodSummary> {
  const params = [orgId, q.from, q.to, q.brandId ?? null];
  const totals = await c.query<PeriodSummary['totals']>(TOTALS_SQL, params);
  const categories = await c.query<PeriodSummary['categories'][number]>(CATEGORIES_SQL, params);
  const topRules = await c.query<PeriodSummary['topRules'][number]>(RULES_SQL, params);
  const threads = await c.query<
    Omit<PeriodSummary['notableThreads'][number], 'postedAt'> & { postedAt: Date }
  >(THREADS_SQL, params);
  return {
    totals: totals.rows[0]!,
    categories: categories.rows,
    topRules: topRules.rows,
    notableThreads: threads.rows.map((t) => ({ ...t, postedAt: t.postedAt.toISOString() })),
  };
}
