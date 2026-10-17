// Who asked for a hide. Both fragments are lateral joins over a moderation_action hide aliased `h`,
// filter organization_id + brand_id on every table, and are shared by Hidden today and the weekly
// report so the two always attribute a hide the same way.

/**
 * `st`: the action run step that executed the hide, if any. `st.run_suggestion_id` is set when a
 * person approved a review-mode suggestion; `st.undo_action_id` is the unhide that undid the step.
 */
export const HIDE_STEP_LATERAL_SQL = `LEFT JOIN LATERAL (
    SELECT s.id, s.undo_action_id, ar.suggestion_id AS run_suggestion_id,
           ar.rule_id AS run_rule_id, ar.rule_evaluation_id AS run_rule_evaluation_id
      FROM action_run_step s
      JOIN action_run ar ON ar.organization_id = s.organization_id AND ar.brand_id = s.brand_id
                        AND ar.id = s.run_id
     WHERE s.organization_id = h.organization_id AND s.brand_id = h.brand_id
       AND s.moderation_action_id = h.id) st ON true`;

/**
 * `dec`: the enforced hide/remove decision that requested the hide, through its rule run step or by
 * the request key the decision's own job used (see apps/api decisions.queries.ts). Needs `st`.
 */
export const HIDE_DECISION_LATERAL_SQL = `LEFT JOIN LATERAL (
    SELECT d.reason, d.category, d.policy_revision_id
      FROM decision d
     WHERE d.organization_id = h.organization_id AND d.brand_id = h.brand_id
       AND d.comment_id = h.comment_id AND d.mode = 'enforce' AND d.outcome IN ('hide', 'remove')
       AND ((d.actor_type = 'rule' AND (
               h.request_key = 'rule-eval:' || d.rule_evaluation_id
               OR (st.run_rule_evaluation_id = d.rule_evaluation_id AND st.run_rule_id = d.rule_id)))
         OR (d.actor_type = 'classifier' AND NOT d.reversal
             AND h.request_key = 'clf:' || d.classification_id)
         OR (d.actor_type = 'policy' AND h.request_key = 'pol:' || d.policy_evaluation_id))
     ORDER BY d.sequence DESC
     LIMIT 1) dec ON true`;
