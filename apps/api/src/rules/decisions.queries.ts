import type pg from 'pg';
import type { Category, Downgrade, Trigger } from '@feedbouncer/classifier';
import type { Downgrade as PolicyDowngrade, PolicyAction } from '@feedbouncer/policies';
import type { RuleAction, RuleKind, RuleMode } from '@feedbouncer/rules';
import type { BrandScope } from '../tenancy/brand-scope.js';

export interface DecisionDto {
  id: string;
  outcome: RuleAction;
  mode: RuleMode;
  actorType: 'user' | 'rule' | 'classifier' | 'policy';
  rule: { id: string; name: string; kind: RuleKind | null; archived: boolean } | null;
  reason: string;
  createdAt: string;
  /** True when this is the flag a rule's failed or deferred action fell back to. */
  fallback: boolean;
  action: { kind: string; status: string; outcomeCode: string | null } | null;
  /** The classifier's evidence for a classifier decision; null for rules and people. */
  classifier: {
    category: Category;
    score: number;
    threshold: number;
    provider: string | null;
    model: string | null;
    triggers: Trigger[];
    downgraded: Downgrade | null;
    /** An earlier hide lifted because a re-score fell below the threshold. */
    reversal: boolean;
  } | null;
  /** The policy behind a policy decision, as it was at that revision; null otherwise. */
  policy: {
    evaluationId: string;
    policyId: string;
    name: string;
    archived: boolean;
    revision: number;
    text: string;
    matches: {
      policyId: string;
      name: string;
      archived: boolean;
      revision: number;
      confidence: 'high' | 'low';
      action: PolicyAction;
      effectiveAction: PolicyAction;
      downgrade: PolicyDowngrade | null;
    }[];
  } | null;
}

export interface ActivityItem extends DecisionDto {
  commentId: string;
  /** First 140 characters of the comment, plain text. */
  commentExcerpt: string;
  platform: string;
}

interface DecisionRow {
  id: string;
  sequence: string;
  comment_id: string;
  outcome: RuleAction;
  mode: RuleMode;
  actor_type: DecisionDto['actorType'];
  reason: string;
  created_at: Date;
  rule_id: string | null;
  rule_name: string | null;
  rule_kind: RuleKind | null;
  rule_archived: boolean | null;
  fallback: boolean;
  action_kind: string | null;
  action_status: string | null;
  action_outcome_code: string | null;
  classification_id: string | null;
  category: Category | null;
  confidence: string | null;
  threshold: string | null;
  classifier_provider: string | null;
  classifier_model: string | null;
  triggers: Trigger[] | null;
  downgraded: Downgrade | null;
  reversal: boolean;
  policy_evaluation_id: string | null;
  policy_id: string | null;
  policy_name: string | null;
  policy_archived: boolean | null;
  policy_revision: number | null;
  policy_text: string | null;
  policy_matches: NonNullable<DecisionDto['policy']>['matches'] | null;
}

// Rules, classifications and actions are joined on the decision's own organization
// and brand. The action is the platform call of the decision: a rule evaluation
// (the action its run step requested, or request_key rule-eval:<id> before action steps), a classification (clf:<id>, clf:<id>:unhide for a
// reversal) or a policy evaluation (pol:<id>); it belongs to the enforced decisions only, not to dry-run suggestions.
const DECISION_FROM = `
  FROM decision d
  LEFT JOIN rule r ON r.organization_id = d.organization_id AND r.brand_id = d.brand_id
                  AND r.id = d.rule_id
  LEFT JOIN rule_evaluation e ON e.organization_id = d.organization_id AND e.brand_id = d.brand_id
                             AND e.id = d.rule_evaluation_id
  LEFT JOIN comment_classification cc ON cc.organization_id = d.organization_id
                                     AND cc.brand_id = d.brand_id AND cc.id = d.classification_id
  LEFT JOIN custom_policy_revision pr ON pr.organization_id = d.organization_id
                                     AND pr.brand_id = d.brand_id AND pr.id = d.policy_revision_id
  LEFT JOIN custom_policy cp ON cp.brand_id = pr.brand_id AND cp.id = pr.policy_id
  LEFT JOIN policy_evaluation pe ON pe.organization_id = d.organization_id
                                AND pe.brand_id = d.brand_id AND pe.id = d.policy_evaluation_id
  LEFT JOIN moderation_action a ON a.organization_id = d.organization_id AND a.brand_id = d.brand_id
                               AND d.mode = 'enforce'
                               AND CASE
                                 WHEN d.actor_type = 'rule' AND d.outcome IN ('hide', 'remove')
                                      AND EXISTS (SELECT 1 FROM action_run ar
                                                   WHERE ar.organization_id = d.organization_id
                                                     AND ar.brand_id = d.brand_id
                                                     AND ar.rule_evaluation_id = d.rule_evaluation_id
                                                     AND ar.rule_id = d.rule_id)
                                   THEN a.id = (SELECT s.moderation_action_id
                                                  FROM action_run ar
                                                  JOIN action_run_step s ON s.run_id = ar.id
                                                 WHERE ar.organization_id = d.organization_id
                                                   AND ar.brand_id = d.brand_id
                                                   AND ar.rule_evaluation_id = d.rule_evaluation_id
                                                   AND ar.rule_id = d.rule_id
                                                   AND s.step_type = CASE d.outcome
                                                         WHEN 'remove' THEN 'delete' ELSE 'hide' END)
                                 ELSE a.request_key = CASE
                                   WHEN d.actor_type = 'rule' THEN 'rule-eval:' || d.rule_evaluation_id
                                   WHEN d.actor_type = 'classifier' AND d.reversal
                                     THEN 'clf:' || d.classification_id || ':unhide'
                                   WHEN d.actor_type = 'classifier' THEN 'clf:' || d.classification_id
                                   WHEN d.actor_type = 'policy' THEN 'pol:' || d.policy_evaluation_id
                                 END
                               END`;

const DECISION_COLUMNS = `
  d.id, d.sequence::text AS sequence, d.comment_id, d.outcome, d.mode, d.actor_type, d.reason,
  d.created_at, d.rule_id, r.name AS rule_name, r.kind AS rule_kind,
  (r.archived_at IS NOT NULL) AS rule_archived,
  COALESCE(d.mode = 'enforce' AND d.outcome = 'flag' AND d.rule_id = e.matched_rule_id
           AND e.outcome <> 'flag', false)
  OR COALESCE(d.actor_type = 'classifier' AND d.outcome = 'flag' AND cc.fallback_at IS NOT NULL
              AND d.created_at >= cc.fallback_at, false)
  OR COALESCE(d.actor_type = 'policy' AND d.outcome = 'flag' AND pe.fallback_at IS NOT NULL
              AND d.created_at >= pe.fallback_at, false) AS fallback,
  a.kind AS action_kind, a.status AS action_status, a.outcome_code AS action_outcome_code,
  d.classification_id, d.category, d.confidence::text AS confidence, d.threshold::text AS threshold,
  d.classifier_provider, d.classifier_model, d.reversal, cc.triggers, cc.downgraded,
  d.policy_evaluation_id, pr.policy_id, cp.name AS policy_name,
  (cp.archived_at IS NOT NULL) AS policy_archived, pr.revision AS policy_revision,
  pr.text AS policy_text,
  (SELECT COALESCE(json_agg(json_build_object(
      'policyId', mr.policy_id, 'name', mp.name, 'archived', mp.archived_at IS NOT NULL,
      'revision', mr.revision, 'confidence', m.confidence, 'action', m.configured_action,
      'effectiveAction', m.effective_action, 'downgrade', m.downgrade)
      ORDER BY mp.created_at, mp.id), '[]'::json)
     FROM policy_evaluation_match m
     JOIN custom_policy_revision mr ON mr.brand_id = m.brand_id AND mr.id = m.revision_id
     JOIN custom_policy mp ON mp.brand_id = mr.brand_id AND mp.id = mr.policy_id
    WHERE m.organization_id = d.organization_id AND m.brand_id = d.brand_id
      AND m.evaluation_id = d.policy_evaluation_id) AS policy_matches`;

function toClassifier(r: DecisionRow): DecisionDto['classifier'] {
  if (r.actor_type !== 'classifier' || r.classification_id === null) return null;
  if (r.category === null || r.confidence === null || r.threshold === null) return null;
  const score = Number(r.confidence);
  const threshold = Number(r.threshold);
  return {
    category: r.category,
    score,
    threshold,
    provider: r.classifier_provider,
    model: r.classifier_model,
    triggers: r.triggers ?? [],
    downgraded: r.downgraded,
    reversal: r.reversal,
  };
}

function toPolicy(r: DecisionRow): DecisionDto['policy'] {
  if (r.actor_type !== 'policy' || r.policy_evaluation_id === null) return null;
  if (r.policy_id === null || r.policy_name === null || r.policy_revision === null) return null;
  return {
    evaluationId: r.policy_evaluation_id,
    policyId: r.policy_id,
    name: r.policy_name,
    archived: r.policy_archived === true,
    revision: r.policy_revision,
    text: r.policy_text ?? '',
    matches: r.policy_matches ?? [],
  };
}

const toDecision = (r: DecisionRow): DecisionDto => ({
  id: r.id,
  outcome: r.outcome,
  mode: r.mode,
  actorType: r.actor_type,
  rule:
    r.rule_id !== null && r.rule_name !== null
      ? { id: r.rule_id, name: r.rule_name, kind: r.rule_kind, archived: r.rule_archived === true }
      : null,
  reason: r.reason,
  createdAt: r.created_at.toISOString(),
  fallback: r.fallback,
  action:
    r.action_kind !== null && r.action_status !== null
      ? { kind: r.action_kind, status: r.action_status, outcomeCode: r.action_outcome_code }
      : null,
  classifier: toClassifier(r),
  policy: toPolicy(r),
});

/** All decisions on one comment, newest first. */
export async function listCommentDecisions(
  pool: pg.Pool,
  scope: BrandScope,
  commentId: string,
): Promise<DecisionDto[]> {
  const { rows } = await pool.query<DecisionRow>(
    `SELECT ${DECISION_COLUMNS} ${DECISION_FROM}
      WHERE d.organization_id = $1 AND d.brand_id = $2 AND d.comment_id = $3
      ORDER BY d.sequence DESC`,
    [scope.organizationId, scope.brandId, commentId],
  );
  return rows.map(toDecision);
}

/** The newest decision of each given comment; comments without one are absent. */
export async function latestDecisions(
  pool: pg.Pool,
  scope: BrandScope,
  commentIds: string[],
): Promise<Map<string, DecisionDto>> {
  if (commentIds.length === 0) return new Map();
  const { rows } = await pool.query<DecisionRow>(
    `SELECT x.* FROM unnest($3::uuid[]) AS ids(id)
       CROSS JOIN LATERAL (
         SELECT ${DECISION_COLUMNS} ${DECISION_FROM}
          WHERE d.organization_id = $1 AND d.brand_id = $2 AND d.comment_id = ids.id
          ORDER BY d.sequence DESC LIMIT 1) x`,
    [scope.organizationId, scope.brandId, commentIds],
  );
  return new Map(rows.map((r) => [r.comment_id, toDecision(r)]));
}

export interface ActivityQuery {
  ruleId?: string | undefined;
  kind?: RuleKind | undefined;
  outcome?: RuleAction | undefined;
  mode?: RuleMode | undefined;
  /** Only decisions of this actor; rules, the classifier and policies when absent. */
  source?: 'rule' | 'classifier' | 'policy' | undefined;
  /** Only decisions made by a revision of this policy. */
  policyId?: string | undefined;
  category?: Category | undefined;
  /** Decision sequence: only older decisions are returned. */
  before?: string | undefined;
  limit: number;
}

/** Rule, classifier and policy decisions of a brand, newest first. Returns one row more than `limit` when there is a next page. */
export async function listActivity(
  pool: pg.Pool,
  scope: BrandScope,
  q: ActivityQuery,
): Promise<{ item: ActivityItem; sequence: string }[]> {
  const { rows } = await pool.query<DecisionRow & { excerpt: string; platform: string }>(
    `SELECT ${DECISION_COLUMNS}, left(c.body, 140) AS excerpt, cn.platform ${DECISION_FROM}
       JOIN comment c ON c.organization_id = d.organization_id AND c.brand_id = d.brand_id
                     AND c.id = d.comment_id
       JOIN connection cn ON cn.organization_id = c.organization_id AND cn.brand_id = c.brand_id
                         AND cn.id = c.connection_id
      WHERE d.organization_id = $1 AND d.brand_id = $2 AND d.actor_type = ANY($9::text[])
        AND ($3::uuid IS NULL OR d.rule_id = $3)
        AND ($4::text IS NULL OR r.kind = $4)
        AND ($5::text IS NULL OR d.outcome = $5)
        AND ($6::text IS NULL OR d.mode = $6)
        AND ($7::bigint IS NULL OR d.sequence < $7)
        AND ($10::text IS NULL OR d.category = $10)
        AND ($11::uuid IS NULL OR pr.policy_id = $11)
      ORDER BY d.sequence DESC LIMIT $8`,
    [
      scope.organizationId,
      scope.brandId,
      q.ruleId ?? null,
      q.kind ?? null,
      q.outcome ?? null,
      q.mode ?? null,
      q.before ?? null,
      q.limit + 1,
      q.source ? [q.source] : ['rule', 'classifier', 'policy'],
      q.category ?? null,
      q.policyId ?? null,
    ],
  );
  return rows.map((r) => ({
    sequence: r.sequence,
    item: {
      ...toDecision(r),
      commentId: r.comment_id,
      commentExcerpt: r.excerpt,
      platform: r.platform,
    },
  }));
}
