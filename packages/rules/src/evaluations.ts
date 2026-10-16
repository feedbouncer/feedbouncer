// rule_evaluation rows and the decisions they produce. One evaluation per
// (comment, body version, trigger) is the durable idempotency guard; its
// decisions are written in the same transaction, only by the insert that won.
// Every statement filters on organization_id AND brand_id.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { BrandScope } from '@feedbouncer/comments';
import type { Platform } from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { describeDecision } from './reason.js';
import type { ActionStep } from '@feedbouncer/actions';
import type { RuleAction, RuleHit, Verdict } from './types.js';

export type EvaluationStatus = 'no_match' | 'decided' | 'skipped';

export interface EvaluationRow {
  id: string;
  status: EvaluationStatus;
  matchedRuleId: string | null;
  outcome: RuleAction | null;
  fallbackAt: Date | null;
  /** The matched rule's steps when it matched; empty unless decided. */
  matchedActions: ActionStep[];
}

export interface EvaluationRecord {
  commentId: string;
  /** sha256 of the stored body (32 bytes). */
  sha: Buffer;
  triggerKey: string;
  rulesetVersion: string;
  status: EvaluationStatus;
  skipReason?: 'own_account' | 'deleted';
  verdict?: Verdict;
}

/** Fallback codes must fit rule_evaluation_fallback_code_check; anything else is recorded as 'failed'. */
const FALLBACK_CODE = /^[a-z][a-z_]{0,63}$/;
export const safeFallbackCode = (code: string): string =>
  FALLBACK_CODE.test(code) ? code : 'failed';

const COLS = 'id, status, matched_rule_id, outcome, fallback_at, matched_actions';
interface Row {
  id: string;
  status: EvaluationStatus;
  matched_rule_id: string | null;
  outcome: RuleAction | null;
  fallback_at: Date | null;
  matched_actions: ActionStep[] | null;
}
const toRow = (r: Row): EvaluationRow => ({
  id: r.id,
  status: r.status,
  matchedRuleId: r.matched_rule_id,
  outcome: r.outcome,
  fallbackAt: r.fallback_at,
  matchedActions: r.matched_actions ?? [],
});

const INSERT_DECISION = `
  INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id,
                        reason, rule_evaluation_id)
  VALUES ($1, $2, $3, $4, $5, 'rule', $6, $7, $8)`;

export class PgEvaluationStore {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async find(
    scope: BrandScope,
    commentId: string,
    sha: Buffer,
    triggerKey: string,
  ): Promise<EvaluationRow | null> {
    const { rows } = await this.#pool.query<Row>(
      `SELECT ${COLS} FROM rule_evaluation
        WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3
          AND body_sha256 = $4 AND trigger_key = $5`,
      [scope.organizationId, scope.brandId, commentId, sha, triggerKey],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  /**
   * Inserts the evaluation and its decisions in one transaction. Returns null
   * if the key was already recorded (another worker won) or the comment is not
   * a comment of `scope`'s connection.
   */
  async record(scope: ConnectionScope, e: EvaluationRecord): Promise<EvaluationRow | null> {
    const decided = e.status === 'decided' ? (e.verdict?.decided ?? null) : null;
    if (e.status === 'decided' && decided === null)
      throw new TypeError('decided evaluation needs a verdict');
    return withTransaction(this.#pool, async (tx) => {
      const { rows } = await tx.query<Row>(
        `INSERT INTO rule_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                      trigger_key, ruleset_version, status, skip_reason,
                                      matched_rule_id, outcome, trace, matched_actions)
         SELECT c.organization_id, c.brand_id, c.connection_id, c.id, $5::bytea, $6::text,
                $7::text, $8::text, $9::text, $10::uuid, $11::text, $12::jsonb, $13::jsonb
           FROM comment c
          WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3 AND c.id = $4
         ON CONFLICT (comment_id, body_sha256, trigger_key) DO NOTHING
         RETURNING ${COLS}`,
        [
          scope.organizationId,
          scope.brandId,
          scope.connectionId,
          e.commentId,
          e.sha,
          e.triggerKey,
          e.rulesetVersion,
          e.status,
          e.status === 'skipped' ? (e.skipReason ?? null) : null,
          decided?.ruleId ?? null,
          decided?.action ?? null,
          JSON.stringify(e.verdict?.trace ?? []),
          decided ? JSON.stringify(decided.actions) : null,
        ],
      );
      const row = rows[0];
      if (!row) return null;
      const write = (hit: RuleHit, mode: 'suggest' | 'enforce') =>
        tx.query(INSERT_DECISION, [
          scope.organizationId,
          scope.brandId,
          e.commentId,
          hit.action,
          mode,
          hit.ruleId,
          describeDecision(hit),
          row.id,
        ]);
      // Suggestions first: they were seen before the decision point.
      if (e.status !== 'skipped') {
        for (const s of e.verdict?.suggestions ?? []) await write(s, 'suggest');
        if (decided) await write(decided, 'enforce');
      }
      return toRow(row);
    });
  }

  /** Exactly-once: sets fallback_at/fallback_code and appends a 'flag' decision. False if already fell back. */
  async recordFallback(
    scope: BrandScope,
    evaluationId: string,
    code: string,
    reason: string,
  ): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      `WITH f AS (
         UPDATE rule_evaluation SET fallback_at = now(), fallback_code = $4
          WHERE organization_id = $1 AND brand_id = $2 AND id = $3
            AND status = 'decided' AND fallback_at IS NULL
          RETURNING id, comment_id, matched_rule_id
       )
       INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id,
                             reason, rule_evaluation_id)
       SELECT $1, $2, f.comment_id, 'flag', 'enforce', 'rule', f.matched_rule_id, $5, f.id FROM f
       RETURNING id`,
      [scope.organizationId, scope.brandId, evaluationId, safeFallbackCode(code), reason],
    );
    return (rowCount ?? 0) > 0;
  }

  /** After a fallback, the action applied later: sets recovered_at and appends the enforce decision. Once only. */
  async recordRecovered(scope: BrandScope, evaluationId: string, reason: string): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      `WITH r AS (
         UPDATE rule_evaluation SET recovered_at = now()
          WHERE organization_id = $1 AND brand_id = $2 AND id = $3
            AND status = 'decided' AND fallback_at IS NOT NULL AND recovered_at IS NULL
          RETURNING id, comment_id, matched_rule_id, outcome
       )
       INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, rule_id,
                             reason, rule_evaluation_id)
       SELECT $1, $2, r.comment_id, r.outcome, 'enforce', 'rule', r.matched_rule_id, $4, r.id FROM r
       RETURNING id`,
      [scope.organizationId, scope.brandId, evaluationId, reason],
    );
    return (rowCount ?? 0) > 0;
  }

  /** The deciding rule of a decided evaluation (name for the fallback reason). Archived rules still resolve. */
  async loadForFallback(
    scope: BrandScope,
    evaluationId: string,
  ): Promise<{
    ruleId: string;
    ruleName: string;
    outcome: RuleAction;
    commentId: string;
    platform: Platform;
  } | null> {
    const { rows } = await this.#pool.query<{
      rule_id: string;
      rule_name: string;
      outcome: RuleAction;
      comment_id: string;
      platform: Platform;
    }>(
      `SELECT e.matched_rule_id AS rule_id, r.name AS rule_name, e.outcome, e.comment_id, cn.platform
         FROM rule_evaluation e
         JOIN connection cn ON cn.id = e.connection_id
                           AND cn.organization_id = e.organization_id AND cn.brand_id = e.brand_id
         JOIN rule r ON r.id = e.matched_rule_id
                    AND r.organization_id = e.organization_id AND r.brand_id = e.brand_id
        WHERE e.organization_id = $1 AND e.brand_id = $2 AND e.id = $3 AND e.status = 'decided'`,
      [scope.organizationId, scope.brandId, evaluationId],
    );
    const r = rows[0];
    return r
      ? {
          ruleId: r.rule_id,
          ruleName: r.rule_name,
          outcome: r.outcome,
          commentId: r.comment_id,
          platform: r.platform,
        }
      : null;
  }
}
