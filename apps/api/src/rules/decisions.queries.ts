import type pg from 'pg';
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
}

// Rules and actions are joined on the decision's own organization and brand. The
// action is the platform call of the evaluation (request_key rule-eval:<id>); it
// belongs to the enforced decisions only, not to dry-run suggestions.
const DECISION_FROM = `
  FROM decision d
  LEFT JOIN rule r ON r.organization_id = d.organization_id AND r.brand_id = d.brand_id
                  AND r.id = d.rule_id
  LEFT JOIN rule_evaluation e ON e.organization_id = d.organization_id AND e.brand_id = d.brand_id
                             AND e.id = d.rule_evaluation_id
  LEFT JOIN moderation_action a ON a.organization_id = d.organization_id AND a.brand_id = d.brand_id
                               AND d.mode = 'enforce'
                               AND a.request_key = 'rule-eval:' || d.rule_evaluation_id`;

const DECISION_COLUMNS = `
  d.id, d.sequence::text AS sequence, d.comment_id, d.outcome, d.mode, d.actor_type, d.reason,
  d.created_at, d.rule_id, r.name AS rule_name, r.kind AS rule_kind,
  (r.archived_at IS NOT NULL) AS rule_archived,
  COALESCE(d.mode = 'enforce' AND d.outcome = 'flag' AND d.rule_id = e.matched_rule_id
           AND e.outcome <> 'flag', false) AS fallback,
  a.kind AS action_kind, a.status AS action_status, a.outcome_code AS action_outcome_code`;

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
  /** Decision sequence: only older decisions are returned. */
  before?: string | undefined;
  limit: number;
}

/** Rule decisions of a brand, newest first. Returns one row more than `limit` when there is a next page. */
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
      WHERE d.organization_id = $1 AND d.brand_id = $2 AND d.actor_type = 'rule'
        AND ($3::uuid IS NULL OR d.rule_id = $3)
        AND ($4::text IS NULL OR r.kind = $4)
        AND ($5::text IS NULL OR d.outcome = $5)
        AND ($6::text IS NULL OR d.mode = $6)
        AND ($7::bigint IS NULL OR d.sequence < $7)
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
