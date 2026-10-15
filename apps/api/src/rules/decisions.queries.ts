import type pg from 'pg';
import type { Category, Downgrade, Trigger } from '@feedbouncer/classifier';
import type { RuleAction, RuleKind, RuleMode } from '@feedbouncer/rules';
import type { BrandScope } from '../tenancy/brand-scope.js';

export interface DecisionDto {
  id: string;
  outcome: RuleAction;
  mode: RuleMode;
  actorType: 'user' | 'rule' | 'classifier';
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
}

// Rules, classifications and actions are joined on the decision's own organization
// and brand. The action is the platform call of the decision: a rule evaluation
// (request_key rule-eval:<id>) or a classification (clf:<id>, clf:<id>:unhide for a
// reversal); it belongs to the enforced decisions only, not to dry-run suggestions.
const DECISION_FROM = `
  FROM decision d
  LEFT JOIN rule r ON r.organization_id = d.organization_id AND r.brand_id = d.brand_id
                  AND r.id = d.rule_id
  LEFT JOIN rule_evaluation e ON e.organization_id = d.organization_id AND e.brand_id = d.brand_id
                             AND e.id = d.rule_evaluation_id
  LEFT JOIN comment_classification cc ON cc.organization_id = d.organization_id
                                     AND cc.brand_id = d.brand_id AND cc.id = d.classification_id
  LEFT JOIN moderation_action a ON a.organization_id = d.organization_id AND a.brand_id = d.brand_id
                               AND d.mode = 'enforce'
                               AND a.request_key = CASE
                                 WHEN d.actor_type = 'rule' THEN 'rule-eval:' || d.rule_evaluation_id
                                 WHEN d.actor_type = 'classifier' AND d.outcome = 'approve'
                                   THEN 'clf:' || d.classification_id || ':unhide'
                                 WHEN d.actor_type = 'classifier' THEN 'clf:' || d.classification_id
                               END`;

const DECISION_COLUMNS = `
  d.id, d.sequence::text AS sequence, d.comment_id, d.outcome, d.mode, d.actor_type, d.reason,
  d.created_at, d.rule_id, r.name AS rule_name, r.kind AS rule_kind,
  (r.archived_at IS NOT NULL) AS rule_archived,
  COALESCE(d.mode = 'enforce' AND d.outcome = 'flag' AND d.rule_id = e.matched_rule_id
           AND e.outcome <> 'flag', false)
  OR COALESCE(d.actor_type = 'classifier' AND d.outcome = 'flag' AND cc.fallback_at IS NOT NULL
              AND d.created_at >= cc.fallback_at, false) AS fallback,
  a.kind AS action_kind, a.status AS action_status, a.outcome_code AS action_outcome_code,
  d.classification_id, d.category, d.confidence::text AS confidence, d.threshold::text AS threshold,
  d.classifier_provider, d.classifier_model, cc.triggers, cc.downgraded`;

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
    reversal: r.outcome === 'approve' && score < threshold,
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
  /** Only decisions of this actor; both rules and the classifier when absent. */
  source?: 'rule' | 'classifier' | undefined;
  category?: Category | undefined;
  /** Decision sequence: only older decisions are returned. */
  before?: string | undefined;
  limit: number;
}

/** Rule and classifier decisions of a brand, newest first. Returns one row more than `limit` when there is a next page. */
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
      q.source ? [q.source] : ['rule', 'classifier'],
      q.category ?? null,
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
