// Per-account breakdown of a brand's comment activity, for the onboarding review step.
// Same scope rules as the period summary; every statement binds organization_id = $1 and
// comment text is never read.
import type pg from 'pg';

const TOP_CATEGORIES = 3;

export interface AccountBreakdown {
  connectionId: string;
  /** Other people's comments posted in [from, to), any ingest_origin. */
  comments: number;
  /** Of those, the ones imported by a backfill. */
  imported: number;
  /** Comments with at least one decision. */
  checked: number;
  hidden: number;
  /** Comments with a pending action suggestion. */
  awaitingReview: number;
  topCategories: { category: string; count: number }[];
}

// $1 org, $2 from, $3 to, $4 brand. Connections the connection list does not show (an abandoned
// connect, a user-disconnected one) are left out, as are connections of an archived brand.
const BREAKDOWN_SQL = `
SELECT cn.id AS "connectionId",
       (count(c.id))::int AS comments,
       (count(c.id) FILTER (WHERE c.ingest_origin = 'backfill'))::int AS imported,
       (count(c.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM decision d
           WHERE d.organization_id = c.organization_id AND d.brand_id = c.brand_id
             AND d.comment_id = c.id)))::int AS checked,
       (count(c.id) FILTER (WHERE c.platform_state = 'hidden'))::int AS hidden,
       (count(c.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM action_suggestion s
           WHERE s.organization_id = c.organization_id AND s.brand_id = c.brand_id
             AND s.comment_id = c.id AND s.status = 'pending')))::int AS "awaitingReview",
       (SELECT coalesce(jsonb_agg(jsonb_build_object('category', t.category, 'count', t.count)
                                  ORDER BY t.count DESC, t.category), '[]'::jsonb)
          FROM (
            SELECT d.category, count(DISTINCT k.id)::int AS count
              FROM comment k
              JOIN decision d ON d.organization_id = k.organization_id AND d.brand_id = k.brand_id
                             AND d.comment_id = k.id AND d.actor_type = 'classifier'
                             AND d.outcome <> 'approve' AND d.category IS NOT NULL
             WHERE k.organization_id = $1 AND k.connection_id = cn.id AND k.brand_id = cn.brand_id
               AND NOT k.is_own_account AND k.platform_state <> 'deleted'
               AND k.posted_at >= $2 AND k.posted_at < $3
             GROUP BY d.category
             ORDER BY count DESC, d.category
             LIMIT ${TOP_CATEGORIES}) t) AS "topCategories"
  FROM connection cn
  JOIN brand b ON b.organization_id = cn.organization_id AND b.id = cn.brand_id
              AND b.archived_at IS NULL
  LEFT JOIN comment c ON c.organization_id = cn.organization_id AND c.brand_id = cn.brand_id
                     AND c.connection_id = cn.id
                     AND NOT c.is_own_account AND c.platform_state <> 'deleted'
                     AND c.posted_at >= $2 AND c.posted_at < $3
 WHERE cn.organization_id = $1 AND cn.brand_id = $4
   AND NOT (cn.status = 'reconnect_required' AND cn.status_reason = 'oauth_pending')
   AND NOT (cn.status = 'revoked' AND cn.status_reason = 'user_disconnected')
 GROUP BY cn.id, cn.created_at
 ORDER BY cn.created_at, cn.id`;

export async function computeAccountBreakdown(
  c: pg.ClientBase,
  orgId: string,
  q: { from: Date; to: Date; brandId: string },
): Promise<AccountBreakdown[]> {
  const res = await c.query<AccountBreakdown>(BREAKDOWN_SQL, [orgId, q.from, q.to, q.brandId]);
  return res.rows;
}
