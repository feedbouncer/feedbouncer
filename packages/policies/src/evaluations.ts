// policy_evaluation rows, their matches and the decisions they produce. One
// evaluation per (comment, body version, trigger) is the idempotency guard; its
// matches and decision are written in the same transaction, only by the insert
// that won. Every statement filters on organization_id AND brand_id.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { BrandScope } from '@feedbouncer/rules';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type {
  Downgrade,
  EvaluationStatus,
  FailureCode,
  PolicyAction,
  PolicyDecision,
  SkipReason,
} from './types.js';

interface Base {
  commentId: string;
  /** sha256 of the stored body (32 bytes). */
  sha: Buffer;
  triggerKey: string;
}
export type EvaluationRecord =
  | (Base & { status: 'skipped'; skipReason: SkipReason; ruleEvaluationId: string | null })
  | (Base & {
      status: 'failed';
      failureCode: FailureCode;
      ruleEvaluationId: string;
      checkedRevisionIds: readonly string[];
    })
  | (Base & {
      status: 'evaluated';
      ruleEvaluationId: string;
      provider: string;
      model: string;
      promptVersion: string;
      checkedRevisionIds: readonly string[];
      inputTruncated: boolean;
      lowSignal: boolean;
      decision: PolicyDecision;
      reason: string;
    });

export interface EvaluationRow {
  id: string;
  status: EvaluationStatus;
  skipReason: SkipReason | null;
  failureCode: FailureCode | null;
  outcome: PolicyAction | null;
  winningRevisionId: string | null;
  fallbackAt: Date | null;
}

export interface EvaluationView {
  id: string;
  status: EvaluationStatus;
  skipReason: SkipReason | null;
  failureCode: FailureCode | null;
  outcome: PolicyAction | null;
  createdAt: Date;
  checkedCount: number;
  triggerKey: string;
  matches: {
    policyId: string;
    name: string;
    archived: boolean;
    revision: number;
    text: string;
    confidence: 'high' | 'low';
    action: PolicyAction;
    effectiveAction: PolicyAction;
    downgrade: Downgrade | null;
  }[];
}

const COLS = 'id, status, skip_reason, failure_code, outcome, winning_revision_id, fallback_at';
interface Row {
  id: string;
  status: EvaluationStatus;
  skip_reason: SkipReason | null;
  failure_code: FailureCode | null;
  outcome: PolicyAction | null;
  winning_revision_id: string | null;
  fallback_at: Date | null;
}
const toRow = (r: Row): EvaluationRow => ({
  id: r.id,
  status: r.status,
  skipReason: r.skip_reason,
  failureCode: r.failure_code,
  outcome: r.outcome,
  winningRevisionId: r.winning_revision_id,
  fallbackAt: r.fallback_at,
});

const INSERT_DECISION = `
  INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, reason,
                        policy_evaluation_id, policy_revision_id)
  VALUES ($1, $2, $3, $4, 'enforce', 'policy', $5, $6, $7)`;

export class PgPolicyEvaluationStore {
  readonly #pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async find(
    s: BrandScope,
    commentId: string,
    sha: Buffer,
    triggerKey: string,
  ): Promise<EvaluationRow | null> {
    const { rows } = await this.#pool.query<Row>(
      `SELECT ${COLS} FROM policy_evaluation
        WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3
          AND body_sha256 = $4 AND trigger_key = $5`,
      [s.organizationId, s.brandId, commentId, sha, triggerKey],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  /**
   * Inserts the evaluation, its matches and (when a policy won) its decision in
   * one transaction. Null if the key was already recorded (another worker won)
   * or the comment is not a comment of `scope`'s connection.
   */
  async record(scope: ConnectionScope, r: EvaluationRecord): Promise<EvaluationRow | null> {
    const ev = r.status === 'evaluated' ? r : null;
    const winner = ev?.decision.winner ?? null;
    const outcome = ev?.decision.outcome ?? null;
    if ((outcome === null) !== (winner === null))
      throw new TypeError('a policy outcome needs exactly one winning match');
    return withTransaction(this.#pool, async (tx) => {
      const { rows } = await tx.query<Row>(
        `INSERT INTO policy_evaluation (organization_id, brand_id, connection_id, comment_id, body_sha256,
                                        trigger_key, rule_evaluation_id, status, skip_reason, failure_code,
                                        provider, model, prompt_version, checked_revision_ids,
                                        input_truncated, low_signal, outcome, winning_revision_id)
         SELECT c.organization_id, c.brand_id, c.connection_id, c.id, $5::bytea, $6::text, $7::uuid,
                $8::text, $9::text, $10::text, $11::text, $12::text, $13::text, $14::uuid[],
                $15::boolean, $16::boolean, $17::text, $18::uuid
           FROM comment c
          WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3 AND c.id = $4
         ON CONFLICT (comment_id, body_sha256, trigger_key) DO NOTHING
         RETURNING ${COLS}`,
        [
          scope.organizationId,
          scope.brandId,
          scope.connectionId,
          r.commentId,
          r.sha,
          r.triggerKey,
          r.ruleEvaluationId,
          r.status,
          r.status === 'skipped' ? r.skipReason : null,
          r.status === 'failed' ? r.failureCode : null,
          ev?.provider ?? null,
          ev?.model ?? null,
          ev?.promptVersion ?? null,
          r.status === 'skipped' ? [] : [...r.checkedRevisionIds],
          ev?.inputTruncated ?? null,
          ev?.lowSignal ?? null,
          outcome,
          winner?.revisionId ?? null,
        ],
      );
      const row = rows[0];
      if (!row) return null;
      if (ev) {
        for (const m of ev.decision.matches)
          await tx.query(
            `INSERT INTO policy_evaluation_match (organization_id, brand_id, evaluation_id, revision_id,
                                                  confidence, configured_action, effective_action, downgrade)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              scope.organizationId,
              scope.brandId,
              row.id,
              m.revisionId,
              m.confidence,
              m.action,
              m.effectiveAction,
              m.downgrade,
            ],
          );
        if (outcome !== null && winner !== null)
          await tx.query(INSERT_DECISION, [
            scope.organizationId,
            scope.brandId,
            r.commentId,
            outcome,
            ev.reason,
            row.id,
            winner.revisionId,
          ]);
      }
      return toRow(row);
    });
  }

  /**
   * Write-once: sets fallback_at/fallback_code and appends a 'flag' decision
   * (skipped when the comment is gone). False if already fell back or nothing won.
   */
  async recordFallback(
    s: BrandScope,
    evaluationId: string,
    code: string,
    reason: string,
  ): Promise<boolean> {
    return withTransaction(this.#pool, async (tx) => {
      const { rows } = await tx.query<{ comment_id: string; winning_revision_id: string }>(
        `UPDATE policy_evaluation SET fallback_at = now(), fallback_code = $4
          WHERE organization_id = $1 AND brand_id = $2 AND id = $3
            AND status = 'evaluated' AND outcome IS NOT NULL AND fallback_at IS NULL
          RETURNING comment_id, winning_revision_id`,
        [s.organizationId, s.brandId, evaluationId, code],
      );
      const hit = rows[0];
      if (!hit) return false;
      await tx.query(
        `INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, reason,
                               policy_evaluation_id, policy_revision_id)
         SELECT $1, $2, c.id, 'flag', 'enforce', 'policy', $4, $5, $6
           FROM comment c
          WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.id = $3
            AND c.platform_state <> 'deleted'`,
        [
          s.organizationId,
          s.brandId,
          hit.comment_id,
          reason,
          evaluationId,
          hit.winning_revision_id,
        ],
      );
      return true;
    });
  }

  /** After a fallback, the action applied later: sets recovered_at once. */
  async recordRecovered(s: BrandScope, evaluationId: string): Promise<void> {
    await this.#pool.query(
      `UPDATE policy_evaluation SET recovered_at = now()
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3
          AND fallback_at IS NOT NULL AND recovered_at IS NULL`,
      [s.organizationId, s.brandId, evaluationId],
    );
  }

  /** The newest evaluation of a comment, with each match at the revision that matched. */
  async latestForComment(s: BrandScope, commentId: string): Promise<EvaluationView | null> {
    const { rows } = await this.#pool.query<{
      id: string;
      status: EvaluationStatus;
      skip_reason: SkipReason | null;
      failure_code: FailureCode | null;
      outcome: PolicyAction | null;
      created_at: Date;
      checked_count: number;
      trigger_key: string;
    }>(
      `SELECT id, status, skip_reason, failure_code, outcome, created_at,
              cardinality(checked_revision_ids) AS checked_count, trigger_key
         FROM policy_evaluation
        WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [s.organizationId, s.brandId, commentId],
    );
    const e = rows[0];
    if (!e) return null;
    const { rows: ms } = await this.#pool.query<{
      policy_id: string;
      name: string;
      archived: boolean;
      revision: number;
      text: string;
      confidence: 'high' | 'low';
      configured_action: PolicyAction;
      effective_action: PolicyAction;
      downgrade: Downgrade | null;
    }>(
      `SELECT p.id AS policy_id, p.name, (p.archived_at IS NOT NULL) AS archived, r.revision, r.text,
              m.confidence, m.configured_action, m.effective_action, m.downgrade
         FROM policy_evaluation_match m
         JOIN custom_policy_revision r
           ON r.organization_id = m.organization_id AND r.brand_id = m.brand_id AND r.id = m.revision_id
         JOIN custom_policy p
           ON p.organization_id = r.organization_id AND p.brand_id = r.brand_id AND p.id = r.policy_id
        WHERE m.organization_id = $1 AND m.brand_id = $2 AND m.evaluation_id = $3
        ORDER BY p.created_at, p.id`,
      [s.organizationId, s.brandId, e.id],
    );
    return {
      id: e.id,
      status: e.status,
      skipReason: e.skip_reason,
      failureCode: e.failure_code,
      outcome: e.outcome,
      createdAt: e.created_at,
      checkedCount: e.checked_count,
      triggerKey: e.trigger_key,
      matches: ms.map((m) => ({
        policyId: m.policy_id,
        name: m.name,
        archived: m.archived,
        revision: m.revision,
        text: m.text,
        confidence: m.confidence,
        action: m.configured_action,
        effectiveAction: m.effective_action,
        downgrade: m.downgrade,
      })),
    };
  }
}
