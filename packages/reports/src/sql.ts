// SQL fragments behind the weekly report's metric definitions. They never read comment text.
import { HIDE_DECISION_LATERAL_SQL, HIDE_STEP_LATERAL_SQL } from '@feedbouncer/actions';
import { CATEGORIES, type Category } from '@feedbouncer/classifier';

export type ReportBucket = Category | 'rule' | 'custom_policy' | 'other';
export const REPORT_BUCKETS: readonly ReportBucket[] = [
  ...CATEGORIES,
  'rule',
  'custom_policy',
  'other',
];

// Constant identifiers only, so inlining them as literals is safe.
const KNOWN_CATEGORIES = CATEGORIES.map((k) => `'${k}'`).join(', ');

/**
 * Processed, over `comment c`: classified by the classifier, or decided by a rule, the classifier or
 * a custom policy. Rule- and policy-decided comments count so that hidden ⊆ processed.
 */
export const PROCESSED_COMMENT_SQL = `(
  EXISTS (SELECT 1 FROM comment_classification cc
           WHERE cc.organization_id = c.organization_id AND cc.brand_id = c.brand_id
             AND cc.comment_id = c.id AND cc.status = 'classified')
  OR EXISTS (SELECT 1 FROM decision d
              WHERE d.organization_id = c.organization_id AND d.brand_id = c.brand_id
                AND d.comment_id = c.id AND d.actor_type IN ('rule', 'classifier', 'policy')))`;

/**
 * The bucket of a hide `h` with `st` and `dec` in scope (HIDE_STEP_LATERAL_SQL,
 * HIDE_DECISION_LATERAL_SQL). Every hide lands in exactly one bucket. An approved suggestion is
 * bucketed by its first source, as Hidden today shows it; a classifier source's `source_ref` is the
 * comment_classification id (packages/classifier/src/jobs/classify.ts).
 */
export const HIDDEN_BUCKET_SQL = `CASE
    WHEN h.actor_type = 'rule' THEN 'rule'
    WHEN h.actor_type = 'policy' THEN 'custom_policy'
    WHEN h.actor_type = 'classifier' AND dec.category IN (${KNOWN_CATEGORIES}) THEN dec.category
    WHEN h.actor_type = 'user' THEN COALESCE((
      SELECT CASE src.source_type
               WHEN 'rule' THEN 'rule'
               WHEN 'policy' THEN 'custom_policy'
               ELSE (SELECT d.category FROM decision d
                      WHERE d.organization_id = src.organization_id AND d.brand_id = src.brand_id
                        AND d.classification_id = src.source_ref AND d.category IN (${KNOWN_CATEGORIES})
                      ORDER BY d.sequence DESC
                      LIMIT 1)
             END
        FROM action_suggestion_source src
       WHERE src.organization_id = h.organization_id AND src.brand_id = h.brand_id
         AND src.suggestion_id = st.run_suggestion_id
       ORDER BY src.created_at, src.id
       LIMIT 1), 'other')
    ELSE 'other'
  END AS bucket`;

/**
 * `processed`: the organization's ($1) processed, non-own comments posted in [$2, $3).
 * `hidden`: those whose latest applied hide still stands and was FeedBouncer's: the comment is
 * hidden now, nothing reverses the hide, and it was automated or an approved suggestion.
 * `week`: every processed comment with its bucket (null when not hidden).
 */
export const WEEK_COMMENTS_CTES = `
processed AS (
  SELECT c.organization_id, c.brand_id, c.id, c.source_id, c.ad_source_id, c.platform_state
    FROM comment c
   WHERE c.organization_id = $1 AND NOT c.is_own_account
     AND c.posted_at >= $2 AND c.posted_at < $3 AND ${PROCESSED_COMMENT_SQL}),
latest_hide AS (
  SELECT DISTINCT ON (a.comment_id) a.*
    FROM processed p
    JOIN moderation_action a ON a.organization_id = p.organization_id AND a.brand_id = p.brand_id
                            AND a.comment_id = p.id
   WHERE a.organization_id = $1 AND p.platform_state = 'hidden'
     AND a.kind = 'hide' AND a.status = 'applied'
   ORDER BY a.comment_id, a.completed_at DESC, a.id DESC),
hidden AS (
  SELECT h.comment_id, ${HIDDEN_BUCKET_SQL}
    FROM latest_hide h
    ${HIDE_STEP_LATERAL_SQL}
    ${HIDE_DECISION_LATERAL_SQL}
   WHERE (h.actor_type <> 'user' OR st.run_suggestion_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM moderation_action u
                      WHERE u.organization_id = h.organization_id AND u.brand_id = h.brand_id
                        AND u.kind = 'unhide' AND u.status = 'applied'
                        AND (u.reverses_action_id = h.id OR u.id = st.undo_action_id))),
week AS (
  SELECT p.brand_id, p.id, p.source_id, p.ad_source_id, hd.bucket
    FROM processed p
    LEFT JOIN hidden hd ON hd.comment_id = p.id)`;
