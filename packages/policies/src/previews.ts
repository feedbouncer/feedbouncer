// Dry-run previews of a draft policy: one preview row per request and one result
// row per candidate comment. Nothing here is referenced by decisions or actions.
// Every statement filters on organization_id AND brand_id.
import type pg from 'pg';
import { isUniqueViolation } from '@feedbouncer/db';
import type { BrandScope } from '@feedbouncer/rules';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { recentUndecidedComments } from './candidates.js';
import {
  PREVIEW_MAX_COMMENTS,
  PREVIEW_RETENTION_DAYS,
  type PolicyAction,
  type PolicyVerdict,
} from './types.js';

export class PreviewInProgressError extends Error {
  constructor() {
    super('preview_in_progress');
    this.name = 'PreviewInProgressError';
  }
}

export type PreviewStopReason = 'quota_exhausted' | 'evaluator_disabled';

export interface PreviewRow {
  id: string;
  status: 'running' | 'done';
  text: string;
  action: PolicyAction;
}

export interface PreviewResultInput {
  verdict: PolicyVerdict | 'skipped' | 'error';
  proposedAction: PolicyAction | null;
  reason: string | null;
  errorCode: string | null;
}

export interface PreviewView {
  id: string;
  status: 'running' | 'done';
  text: string;
  action: PolicyAction;
  days: number;
  since: Date;
  total: number;
  capped: boolean;
  examined: number;
  matched: number;
  errors: number;
  notChecked: number;
  stoppedReason: PreviewStopReason | null;
  createdAt: Date;
  completedAt: Date | null;
  results: {
    commentId: string;
    verdict: string;
    proposedAction: PolicyAction | null;
    reason: string | null;
    errorCode: string | null;
    excerpt: string;
    platform: string;
  }[];
}

const RUNNING_KEY = 'policy_preview_brand_id_running_key';
const DAY_MS = 86_400_000;

export class PgPolicyPreviewStore {
  readonly #pool: pg.Pool;
  readonly #clock: { now(): number };
  constructor(pool: pg.Pool, clock: { now(): number } = Date) {
    this.#pool = pool;
    this.#clock = clock;
  }

  /**
   * Starts a preview of `r.text` on the brand's recent undecided comments. Runs
   * inside the caller's transaction; a second running preview aborts it with
   * PreviewInProgressError and the caller rolls back.
   */
  async create(
    c: pg.PoolClient,
    s: BrandScope,
    r: {
      policyId: string | null;
      text: string;
      action: PolicyAction;
      days: number;
      userId: string | null;
    },
  ): Promise<{
    id: string;
    total: number;
    capped: boolean;
    connections: { connectionId: string; platform: string }[];
  }> {
    await c.query(
      `DELETE FROM policy_preview
        WHERE organization_id = $1 AND brand_id = $2 AND created_at < now() - make_interval(days => $3)`,
      [s.organizationId, s.brandId, PREVIEW_RETENTION_DAYS],
    );
    const since = new Date(this.#clock.now() - r.days * DAY_MS);
    const { rows } = await c
      .query<{ id: string }>(
        `INSERT INTO policy_preview
           (organization_id, brand_id, policy_id, requested_by_user_id, text, action, days, since, total, capped)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, false) RETURNING id`,
        [s.organizationId, s.brandId, r.policyId, r.userId, r.text, r.action, r.days, since],
      )
      .catch((e: unknown) => {
        if (isUniqueViolation(e, RUNNING_KEY)) throw new PreviewInProgressError();
        throw e;
      });
    const id = rows[0]!.id;
    const found = await recentUndecidedComments(c, s, {
      since,
      limit: PREVIEW_MAX_COMMENTS + 1,
    });
    const capped = found.length > PREVIEW_MAX_COMMENTS;
    const picked = found.slice(0, PREVIEW_MAX_COMMENTS);
    if (picked.length > 0) {
      await c.query(
        `INSERT INTO policy_preview_result (organization_id, brand_id, preview_id, connection_id, comment_id, position)
         SELECT $1, $2, $3, x.connection_id, x.comment_id, x.position - 1
           FROM unnest($4::uuid[], $5::uuid[]) WITH ORDINALITY AS x(connection_id, comment_id, position)`,
        [
          s.organizationId,
          s.brandId,
          id,
          picked.map((p) => p.connectionId),
          picked.map((p) => p.commentId),
        ],
      );
    }
    await c.query(
      `UPDATE policy_preview SET total = $4, capped = $5
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
      [s.organizationId, s.brandId, id, picked.length, capped],
    );
    const connections = new Map(picked.map((p) => [p.connectionId, p.platform]));
    return {
      id,
      total: picked.length,
      capped,
      connections: [...connections].map(([connectionId, platform]) => ({ connectionId, platform })),
    };
  }

  async load(s: BrandScope, previewId: string): Promise<PreviewRow | null> {
    const { rows } = await this.#pool.query<PreviewRow>(
      `SELECT id, status, text, action FROM policy_preview
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
      [s.organizationId, s.brandId, previewId],
    );
    return rows[0] ?? null;
  }

  /** Unchecked rows of one connection, in preview order. */
  async pending(
    s: ConnectionScope,
    previewId: string,
    limit: number,
  ): Promise<{ resultId: string; commentId: string }[]> {
    const { rows } = await this.#pool.query<{ id: string; comment_id: string }>(
      `SELECT id, comment_id FROM policy_preview_result
        WHERE organization_id = $1 AND brand_id = $2 AND preview_id = $3 AND connection_id = $4
          AND verdict IS NULL
        ORDER BY position LIMIT $5`,
      [s.organizationId, s.brandId, previewId, s.connectionId, limit],
    );
    return rows.map((r) => ({ resultId: r.id, commentId: r.comment_id }));
  }

  async saveResult(s: ConnectionScope, resultId: string, r: PreviewResultInput): Promise<void> {
    await this.#pool.query(
      `UPDATE policy_preview_result
          SET verdict = $5, proposed_action = $6, reason = $7, error_code = $8
        WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND id = $4
          AND verdict IS NULL`,
      [
        s.organizationId,
        s.brandId,
        s.connectionId,
        resultId,
        r.verdict,
        r.proposedAction,
        r.reason,
        r.errorCode,
      ],
    );
  }

  async stop(s: BrandScope, previewId: string, reason: PreviewStopReason): Promise<void> {
    await this.#pool.query(
      `UPDATE policy_preview SET status = 'done', completed_at = now(), stopped_reason = $4
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND status = 'running'`,
      [s.organizationId, s.brandId, previewId, reason],
    );
  }

  /** Marks the preview done once no result row is left unchecked. */
  async completeIfDone(s: BrandScope, previewId: string): Promise<boolean> {
    const r = await this.#pool.query(
      `UPDATE policy_preview SET status = 'done', completed_at = now()
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND status = 'running'
          AND NOT EXISTS (SELECT 1 FROM policy_preview_result
                           WHERE organization_id = $1 AND brand_id = $2 AND preview_id = $3
                             AND verdict IS NULL)`,
      [s.organizationId, s.brandId, previewId],
    );
    return r.rowCount === 1;
  }

  async view(s: BrandScope, previewId: string): Promise<PreviewView | null> {
    const { rows } = await this.#pool.query<{
      id: string;
      status: 'running' | 'done';
      text: string;
      action: PolicyAction;
      days: number;
      since: Date;
      total: number;
      capped: boolean;
      stopped_reason: PreviewStopReason | null;
      created_at: Date;
      completed_at: Date | null;
      examined: number;
      matched: number;
      errors: number;
    }>(
      `SELECT p.id, p.status, p.text, p.action, p.days, p.since, p.total, p.capped, p.stopped_reason,
              p.created_at, p.completed_at,
              count(r.id) FILTER (WHERE r.verdict IN ('clear_match', 'possible_match', 'no_match'))::int AS examined,
              count(r.id) FILTER (WHERE r.verdict IN ('clear_match', 'possible_match'))::int AS matched,
              count(r.id) FILTER (WHERE r.verdict = 'error')::int AS errors
         FROM policy_preview p
         LEFT JOIN policy_preview_result r
           ON r.organization_id = p.organization_id AND r.brand_id = p.brand_id AND r.preview_id = p.id
        WHERE p.organization_id = $1 AND p.brand_id = $2 AND p.id = $3
        GROUP BY p.id`,
      [s.organizationId, s.brandId, previewId],
    );
    const p = rows[0];
    if (!p) return null;
    const results = await this.#pool.query<{
      comment_id: string;
      verdict: string;
      proposed_action: PolicyAction | null;
      reason: string | null;
      error_code: string | null;
      excerpt: string;
      platform: string;
    }>(
      `SELECT r.comment_id, r.verdict, r.proposed_action, r.reason, r.error_code,
              left(c.body, 140) AS excerpt, cn.platform
         FROM policy_preview_result r
         JOIN comment c ON c.organization_id = r.organization_id AND c.brand_id = r.brand_id AND c.id = r.comment_id
         JOIN connection cn
           ON cn.organization_id = r.organization_id AND cn.brand_id = r.brand_id AND cn.id = r.connection_id
        WHERE r.organization_id = $1 AND r.brand_id = $2 AND r.preview_id = $3 AND r.verdict IS NOT NULL
        ORDER BY (r.verdict IN ('clear_match', 'possible_match')) DESC, r.position`,
      [s.organizationId, s.brandId, previewId],
    );
    return {
      id: p.id,
      status: p.status,
      text: p.text,
      action: p.action,
      days: p.days,
      since: p.since,
      total: p.total,
      capped: p.capped,
      examined: p.examined,
      matched: p.matched,
      errors: p.errors,
      notChecked: p.total - p.examined - p.errors,
      stoppedReason: p.stopped_reason,
      createdAt: p.created_at,
      completedAt: p.completed_at,
      results: results.rows.map((r) => ({
        commentId: r.comment_id,
        verdict: r.verdict,
        proposedAction: r.proposed_action,
        reason: r.reason,
        errorCode: r.error_code,
        excerpt: r.excerpt,
        platform: r.platform,
      })),
    };
  }
}
