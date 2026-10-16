import type pg from 'pg';
import type { PreparedInput } from '@feedbouncer/ai';
import { withTransaction } from '@feedbouncer/db';
import type { BrandScope, RuleAction } from '@feedbouncer/rules';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { RawClassification } from './provider.js';
import {
  CATEGORIES,
  type Category,
  type CategoryScores,
  type ClassificationSkipReason,
  type ClassificationStatus,
  type ClassifierVerdict,
  type Downgrade,
  type ThresholdPolicy,
  type Trigger,
  type UnclassifiedReason,
} from './types.js';
import type { PreviewRow } from './preview.js';
import { roundScores } from './policy.js';

interface Base {
  commentId: string;
  sha: Buffer;
  triggerKey: string;
  reviewMode?: boolean;
}
export type ClassificationRecord =
  | (Base & { status: 'skipped'; skipReason: ClassificationSkipReason; inputChars: number })
  | (Base & {
      status: 'unclassified';
      unclassifiedReason: UnclassifiedReason;
      input: PreparedInput;
    })
  | (Base & {
      status: 'classified';
      provider: string;
      model: string;
      promptVersion: string;
      scores: CategoryScores;
      language: string;
      languageSupported: boolean;
      input: PreparedInput;
      scoresReused: boolean;
      ruleEvaluationId: string;
      ruleDecided: boolean;
      policy: ThresholdPolicy;
      verdict: ClassifierVerdict;
      reason: string;
    });

export interface ClassificationRow {
  id: string;
  status: ClassificationStatus;
  outcome: RuleAction | null;
  ruleDecided: boolean;
  fallbackAt: Date | null;
  reversedAt: Date | null;
  scores: CategoryScores | null;
  triggers: Trigger[];
  provider: string | null;
  model: string | null;
  /** Whether the connection's review window was active when this was classified. */
  reviewMode: boolean;
}

export interface ClassificationView {
  id: string;
  status: ClassificationStatus;
  skipReason: ClassificationSkipReason | null;
  unclassifiedReason: UnclassifiedReason | null;
  provider: string | null;
  model: string | null;
  scores: CategoryScores | null;
  language: string | null;
  languageSupported: boolean | null;
  lowSignal: boolean;
  truncated: boolean;
  inputChars: number;
  ruleDecided: boolean;
  outcome: RuleAction | null;
  triggers: Trigger[];
  downgraded: Downgrade | null;
  createdAt: string;
}

export interface FallbackEvidence {
  category: Category;
  score: number;
  threshold: number;
}

interface DbRow {
  id: string;
  status: ClassificationStatus;
  outcome: RuleAction | null;
  rule_decided: boolean;
  fallback_at: Date | null;
  reversed_at: Date | null;
  scores: CategoryScores | null;
  triggers: Trigger[];
  provider: string | null;
  model: string | null;
  review_mode: boolean;
}
const COLUMNS =
  'id, status, outcome, rule_decided, fallback_at, reversed_at, scores, triggers, provider, model, review_mode';
const toRow = (r: DbRow): ClassificationRow => ({
  id: r.id,
  status: r.status,
  outcome: r.outcome,
  ruleDecided: r.rule_decided,
  fallbackAt: r.fallback_at,
  reversedAt: r.reversed_at,
  scores: r.scores,
  triggers: r.triggers,
  provider: r.provider,
  model: r.model,
  reviewMode: r.review_mode,
});

const INSERT_CLASSIFICATION = `
INSERT INTO comment_classification (organization_id, brand_id, connection_id, comment_id, body_sha256, trigger_key, status,
  skip_reason, unclassified_reason, provider, model, prompt_version, scores, language, language_supported, low_signal,
  truncated, input_chars, scores_reused, rule_evaluation_id, rule_decided, policy, outcome, triggers, downgraded,
  review_mode)
SELECT c.organization_id, c.brand_id, c.connection_id, c.id, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15,
  $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $24::jsonb, $25, $26
FROM comment c
WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3 AND c.id = $4
ON CONFLICT (comment_id, body_sha256, trigger_key) DO NOTHING
RETURNING ${COLUMNS}`;

const INSERT_DECISION = `
INSERT INTO decision (organization_id, brand_id, comment_id, outcome, mode, actor_type, classifier_provider,
  classifier_model, category, confidence, threshold, classification_id, reason, reversal)
VALUES ($1, $2, $3, $4, $13, 'classifier', $5, $6, $7, $8, $9, $10, $11, $12)`;

const CLF_KEY = /^clf:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export class PgClassificationStore {
  constructor(private readonly pool: pg.Pool) {}

  async find(
    s: BrandScope,
    commentId: string,
    sha: Buffer,
    triggerKey: string,
  ): Promise<ClassificationRow | null> {
    const r = await this.pool.query<DbRow>(
      `SELECT ${COLUMNS} FROM comment_classification
       WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3 AND body_sha256 = $4 AND trigger_key = $5`,
      [s.organizationId, s.brandId, commentId, sha, triggerKey],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  }

  /** Null when the insert race was lost or the comment is not in this connection's scope. */
  async record(scope: ConnectionScope, r: ClassificationRecord): Promise<ClassificationRow | null> {
    const classified = r.status === 'classified' ? r : null;
    const input = r.status === 'skipped' ? null : (r.input ?? null);
    const outcome = classified && !classified.ruleDecided ? classified.verdict.outcome : null;
    if (outcome !== null && !classified?.verdict.primary)
      throw new Error('classification outcome has no primary trigger');
    const values = [
      scope.organizationId,
      scope.brandId,
      scope.connectionId,
      r.commentId,
      r.sha,
      r.triggerKey,
      r.status,
      r.status === 'skipped' ? r.skipReason : null,
      r.status === 'unclassified' ? r.unclassifiedReason : null,
      classified?.provider ?? null,
      classified?.model ?? null,
      classified?.promptVersion ?? null,
      classified ? JSON.stringify(roundScores(classified.scores)) : null,
      classified?.language ?? null,
      classified?.languageSupported ?? null,
      input?.lowSignal ?? false,
      input?.truncated ?? false,
      r.status === 'skipped' ? r.inputChars : input!.inputChars,
      classified?.scoresReused ?? false,
      classified?.ruleEvaluationId ?? null,
      classified?.ruleDecided ?? false,
      classified ? JSON.stringify(CATEGORIES.map((c) => classified.policy[c])) : null,
      outcome,
      JSON.stringify(classified?.verdict.triggers ?? []),
      classified?.verdict.downgraded ?? null,
      r.reviewMode ?? false,
    ];
    return withTransaction(this.pool, async (c) => {
      const ins = await c.query<DbRow>(INSERT_CLASSIFICATION, values);
      const row = ins.rows[0];
      if (!row) return null;
      const primary = classified?.verdict.primary;
      if (classified && outcome !== null && primary) {
        await c.query(INSERT_DECISION, [
          scope.organizationId,
          scope.brandId,
          r.commentId,
          outcome,
          classified.provider,
          classified.model,
          primary.category,
          primary.score,
          primary.threshold,
          row.id,
          classified.reason,
          false,
          r.reviewMode && (outcome === 'hide' || outcome === 'remove') ? 'suggest' : 'enforce',
        ]);
      }
      return toRow(row);
    });
  }

  async findReusableScores(
    s: BrandScope,
    commentId: string,
    sha: Buffer,
    provider: string,
    model: string,
    promptVersion: string,
  ): Promise<RawClassification | null> {
    const r = await this.pool.query<{ scores: CategoryScores; language: string }>(
      `SELECT scores, language FROM comment_classification
       WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3 AND body_sha256 = $4
         AND status = 'classified' AND provider = $5 AND model = $6 AND prompt_version = $7
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [s.organizationId, s.brandId, commentId, sha, provider, model, promptVersion],
    );
    const row = r.rows[0];
    return row ? { scores: row.scores, language: row.language } : null;
  }

  /** Write-once; appends a flag decision carrying the evidence. Returns false when already recorded. */
  async recordFallback(
    s: BrandScope,
    classificationId: string,
    code: string,
    reason: string,
    evidence?: FallbackEvidence,
  ): Promise<boolean> {
    return withTransaction(this.pool, async (c) => {
      const u = await c.query<{
        comment_id: string;
        provider: string | null;
        model: string | null;
      }>(
        `UPDATE comment_classification SET fallback_at = now(), fallback_code = $4
         WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND fallback_at IS NULL
         RETURNING comment_id, provider, model`,
        [s.organizationId, s.brandId, classificationId, code],
      );
      const row = u.rows[0];
      if (!row) return false;
      let ev: FallbackEvidence | null = evidence ?? null;
      if (!ev) {
        // The evidence is the decision that named the deciding trigger: the hide or remove, else the approve of a reversal.
        const a = await c.query<{ category: Category; confidence: string; threshold: string }>(
          `SELECT category, confidence::text AS confidence, threshold::text AS threshold FROM decision
           WHERE organization_id = $1 AND brand_id = $2 AND classification_id = $3 AND outcome IN ('hide', 'remove', 'approve')
             AND category IS NOT NULL AND confidence IS NOT NULL AND threshold IS NOT NULL
           ORDER BY (outcome = 'approve'), sequence ASC LIMIT 1`,
          [s.organizationId, s.brandId, classificationId],
        );
        const x = a.rows[0];
        if (x)
          ev = {
            category: x.category,
            score: Number(x.confidence),
            threshold: Number(x.threshold),
          };
      }
      if (!ev || !row.provider || !row.model)
        throw new Error('classification has no decision evidence');
      await c.query(INSERT_DECISION, [
        s.organizationId,
        s.brandId,
        row.comment_id,
        'flag',
        row.provider,
        row.model,
        ev.category,
        ev.score,
        ev.threshold,
        classificationId,
        reason,
        false,
        'enforce',
      ]);
      return true;
    });
  }

  /** The reason written with the hide or remove decision, for a suggestion made from it. */
  async decisionReason(s: BrandScope, classificationId: string): Promise<string | null> {
    const r = await this.pool.query<{ reason: string }>(
      `SELECT reason FROM decision
       WHERE organization_id = $1 AND brand_id = $2 AND classification_id = $3 AND outcome IN ('hide', 'remove')
       ORDER BY sequence LIMIT 1`,
      [s.organizationId, s.brandId, classificationId],
    );
    return r.rows[0]?.reason ?? null;
  }

  async recordRecovered(s: BrandScope, classificationId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE comment_classification SET recovered_at = now()
       WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND fallback_at IS NOT NULL AND recovered_at IS NULL`,
      [s.organizationId, s.brandId, classificationId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async reversibleClassifierHide(
    s: BrandScope,
    commentId: string,
  ): Promise<{ classificationId: string; category: Category; threshold: number } | null> {
    const a = await this.pool.query<{
      actor_type: string;
      kind: string;
      status: string;
      request_key: string;
    }>(
      `SELECT a.actor_type, a.kind, a.status, a.request_key
       FROM moderation_action a
       WHERE a.organization_id = $1 AND a.brand_id = $2 AND a.comment_id = $3 AND a.status IN ('pending', 'applied')
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 1`,
      [s.organizationId, s.brandId, commentId],
    );
    const last = a.rows[0];
    if (
      !last ||
      last.actor_type !== 'classifier' ||
      last.kind !== 'hide' ||
      last.status !== 'applied'
    )
      return null;
    const classificationId = CLF_KEY.exec(last.request_key)?.[1];
    if (!classificationId) return null;
    const d = await this.pool.query<{ category: Category; threshold: string }>(
      `SELECT category, threshold::text AS threshold FROM decision
       WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3 AND classification_id = $4
         AND outcome = 'hide' AND category IS NOT NULL AND threshold IS NOT NULL
       ORDER BY sequence DESC LIMIT 1`,
      [s.organizationId, s.brandId, commentId, classificationId],
    );
    const row = d.rows[0];
    return row
      ? { classificationId, category: row.category, threshold: Number(row.threshold) }
      : null;
  }

  /** Write-once; appends an approve decision. Returns false when already reversed. */
  async recordReversal(
    s: BrandScope,
    classificationId: string,
    category: Category,
    score: number,
    threshold: number,
    reason: string,
  ): Promise<boolean> {
    return withTransaction(this.pool, async (c) => {
      const u = await c.query<{
        comment_id: string;
        provider: string | null;
        model: string | null;
      }>(
        `UPDATE comment_classification SET reversed_at = now()
         WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND reversed_at IS NULL
         RETURNING comment_id, provider, model`,
        [s.organizationId, s.brandId, classificationId],
      );
      const row = u.rows[0];
      if (!row) return false;
      if (!row.provider || !row.model) throw new Error('classification has no provider');
      await c.query(INSERT_DECISION, [
        s.organizationId,
        s.brandId,
        row.comment_id,
        'approve',
        row.provider,
        row.model,
        category,
        score,
        threshold,
        classificationId,
        reason,
        true,
        'enforce',
      ]);
      return true;
    });
  }

  async previewRows(
    s: BrandScope,
    since: Date,
    limit: number,
  ): Promise<{ rows: PreviewRow[]; capped: boolean }> {
    const r = await this.pool.query<{
      comment_id: string;
      scores: CategoryScores;
      low_signal: boolean;
      language_supported: boolean;
    }>(
      `SELECT comment_id, scores, low_signal, language_supported
       FROM (
         SELECT DISTINCT ON (cc.comment_id) cc.comment_id, cc.scores, cc.low_signal, cc.language_supported,
                cc.rule_decided, cc.created_at
         FROM comment_classification cc
         JOIN comment c ON c.brand_id = cc.brand_id AND c.id = cc.comment_id
         WHERE cc.organization_id = $1 AND cc.brand_id = $2 AND cc.status = 'classified' AND cc.created_at >= $3
           AND c.organization_id = $1 AND c.platform_state <> 'deleted' AND c.ingest_origin = 'live'
         ORDER BY cc.comment_id, cc.created_at DESC, cc.id DESC
       ) latest
       WHERE NOT rule_decided
       ORDER BY created_at DESC, comment_id
       LIMIT $4`,
      [s.organizationId, s.brandId, since, limit + 1],
    );
    return {
      capped: r.rows.length > limit,
      rows: r.rows.slice(0, limit).map((x) => ({
        commentId: x.comment_id,
        scores: x.scores,
        lowSignal: x.low_signal,
        languageSupported: x.language_supported,
      })),
    };
  }

  async latestForComment(s: BrandScope, commentId: string): Promise<ClassificationView | null> {
    const r = await this.pool.query<
      DbRow & {
        skip_reason: ClassificationSkipReason | null;
        unclassified_reason: UnclassifiedReason | null;
        language: string | null;
        language_supported: boolean | null;
        low_signal: boolean;
        truncated: boolean;
        input_chars: number;
        downgraded: Downgrade | null;
        created_at: Date;
      }
    >(
      `SELECT ${COLUMNS}, skip_reason, unclassified_reason, language, language_supported, low_signal, truncated,
              input_chars, downgraded, created_at
       FROM comment_classification
       WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [s.organizationId, s.brandId, commentId],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      id: x.id,
      status: x.status,
      skipReason: x.skip_reason,
      unclassifiedReason: x.unclassified_reason,
      provider: x.provider,
      model: x.model,
      scores: x.scores,
      language: x.language,
      languageSupported: x.language_supported,
      lowSignal: x.low_signal,
      truncated: x.truncated,
      inputChars: x.input_chars,
      ruleDecided: x.rule_decided,
      outcome: x.outcome,
      triggers: x.triggers,
      downgraded: x.downgraded,
      createdAt: x.created_at.toISOString(),
    };
  }
}
