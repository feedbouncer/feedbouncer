// Suggestions: what automation would have done during review mode, waiting for a person.
// Every statement filters organization_id + brand_id (plus connection_id on writes that
// carry a connection scope) and is parameterised. commentBody is returned to the caller for
// display and must never be logged.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { BrandScope } from '@feedbouncer/comments';
import {
  REVIEW_GRACE_MS,
  type ConnectionStatus,
  type Platform,
  type ReviewMode,
  type ReviewModeColumns,
} from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { ActionStep, StepStatus, StepType } from './steps.js';
import { mergePlan, splitGated, type GatedStep, type SuggestionStatus } from './suggestion-plan.js';
import { clampLimit } from './support.js';

export type SuggestionSourceInput =
  | { type: 'rule'; ref: string; ruleId: string; alsoMatchedRuleIds: readonly string[] }
  | { type: 'classifier' | 'policy'; ref: string };

export interface SuggestionSourceView {
  type: 'rule' | 'classifier' | 'policy';
  ruleId: string | null;
  ruleName: string | null;
  ruleLive: boolean;
  alsoMatched: { ruleId: string; ruleName: string }[];
  steps: GatedStep[];
  reason: string;
  createdAt: Date;
}

export interface SuggestionView {
  id: string;
  connectionId: string;
  platform: Platform;
  commentId: string;
  commentBody: string;
  authorId: string | null;
  authorName: string | null;
  authorPendingCount: number;
  /** Effective: computed with `now`, not necessarily what is stored. */
  status: SuggestionStatus;
  statusReason: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByName: string | null;
  expiresAt: Date | null;
  sources: SuggestionSourceView[];
  plan: ReturnType<typeof mergePlan>;
  execution: {
    runId: string;
    steps: { type: StepType; status: StepStatus; reason: string | null }[];
  } | null;
}

export interface SuggestionFilter {
  /** Defaults to 'pending'. */
  status?: SuggestionStatus | 'all';
  connectionId?: string;
  ruleId?: string;
  authorId?: string;
  stepType?: GatedStep['type'];
  before?: string;
  limit: number;
}

export interface LockedSuggestion {
  id: string;
  connectionId: string;
  commentId: string;
  status: SuggestionStatus;
  requestKey: string | null;
  decidedAt: Date | null;
  decidedByName: string | null;
  commentState: 'visible' | 'hidden' | 'deleted' | null;
  bodyChanged: boolean;
  connectionStatus: ConnectionStatus;
  reviewMode: ReviewModeColumns;
  sources: (SuggestionSourceView & { ruleCurrentGated: GatedStep[] | null })[];
}

interface SuggestionDb {
  id: string;
  connection_id: string;
  platform: Platform;
  comment_id: string;
  body: string | null;
  author_id: string | null;
  author_name: string | null;
  author_pending: number;
  eff_status: SuggestionStatus;
  eff_reason: string | null;
  created_at: Date;
  decided_at: Date | null;
  decided_by_name: string | null;
  expires_at: Date | null;
}

interface SourceDb {
  suggestion_id: string;
  source_type: 'rule' | 'classifier' | 'policy';
  rule_id: string | null;
  rule_name: string | null;
  rule_live: boolean;
  rule_actions: ActionStep[] | null;
  also_matched: { ruleId: string; ruleName: string }[];
  steps: GatedStep[];
  reason: string;
  created_at: Date;
}

interface RunDb {
  suggestion_id: string;
  run_id: string;
  steps: { type: StepType; status: StepStatus; reason: string | null }[];
}

const GRACE_SECONDS = REVIEW_GRACE_MS / 1000;

// SQL twin of graceEndsAt().
export const GRACE_SQL = `CASE WHEN cn.review_mode = 'on' AND cn.review_mode_started_at IS NOT NULL
       THEN coalesce(cn.review_mode_ended_at, cn.review_mode_ends_at) + ${GRACE_SECONDS} * interval '1 second' END`;

export const BODY_CHANGED_SQL = `(c.id IS NOT NULL AND sha256(convert_to(c.body, 'UTF8')) <> s.body_sha256)`;

/** Every suggestion of the brand with its effective status; $1 organization, $2 brand, $3 now. */
const EFFECTIVE_SQL = `
  SELECT s.id, s.connection_id, cn.platform, s.comment_id, c.body, s.author_id, au.display_name AS author_name,
         s.created_at, s.decided_at, u.display_name AS decided_by_name, s.status AS stored_status,
         CASE WHEN s.status <> 'pending' THEN s.status
              WHEN c.id IS NULL OR c.platform_state = 'deleted' OR ${BODY_CHANGED_SQL} THEN 'not_applicable'
              WHEN ${GRACE_SQL} <= $3 THEN 'expired'
              ELSE 'pending' END AS eff_status,
         CASE WHEN s.status <> 'pending' THEN s.status_reason
              WHEN c.id IS NULL OR c.platform_state = 'deleted' THEN 'comment_gone'
              WHEN ${BODY_CHANGED_SQL} THEN 'comment_edited'
              WHEN ${GRACE_SQL} <= $3 THEN 'grace_period_ended' END AS eff_reason,
         CASE WHEN s.status = 'pending' THEN ${GRACE_SQL} END AS expires_at
    FROM action_suggestion s
    JOIN connection cn ON cn.organization_id = s.organization_id AND cn.brand_id = s.brand_id AND cn.id = s.connection_id
    LEFT JOIN comment c ON c.organization_id = s.organization_id AND c.brand_id = s.brand_id AND c.id = s.comment_id
    LEFT JOIN author au ON au.organization_id = s.organization_id AND au.brand_id = s.brand_id
                       AND au.connection_id = s.connection_id AND au.id = s.author_id
    LEFT JOIN app_user u ON u.id = s.decided_by_user_id
   WHERE s.organization_id = $1 AND s.brand_id = $2`;

const PENDING_CTES = `
  eff AS (${EFFECTIVE_SQL}),
  pend AS (SELECT connection_id, author_id, count(*)::int AS n FROM eff
            WHERE eff_status = 'pending' AND author_id IS NOT NULL GROUP BY connection_id, author_id)`;

const SOURCES_SQL = `SELECT ss.suggestion_id, ss.source_type, ss.rule_id, ru.name AS rule_name,
         coalesce(ru.enabled AND ru.archived_at IS NULL AND ru.mode = 'enforce', false) AS rule_live,
         ru.actions AS rule_actions, ss.steps, ss.reason, ss.created_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object('ruleId', r2.id, 'ruleName', r2.name) ORDER BY r2.name, r2.id)
                     FROM rule r2
                    WHERE r2.organization_id = ss.organization_id AND r2.brand_id = ss.brand_id
                      AND r2.id = ANY(ss.also_matched_rule_ids)), '[]'::jsonb) AS also_matched
    FROM action_suggestion_source ss
    LEFT JOIN rule ru ON ru.organization_id = ss.organization_id AND ru.brand_id = ss.brand_id AND ru.id = ss.rule_id
   WHERE ss.organization_id = $1 AND ss.brand_id = $2 AND ss.suggestion_id = ANY($3::uuid[])
   ORDER BY ss.created_at, ss.id`;

const toSource = (
  r: SourceDb,
): SuggestionSourceView & { ruleCurrentGated: GatedStep[] | null } => ({
  type: r.source_type,
  ruleId: r.rule_id,
  ruleName: r.rule_name,
  ruleLive: r.rule_live,
  alsoMatched: r.also_matched,
  steps: r.steps,
  reason: r.reason,
  createdAt: r.created_at,
  ruleCurrentGated: r.rule_live && r.rule_actions ? splitGated(r.rule_actions).gated : null,
});

function stripGated(source: ReturnType<typeof toSource>): SuggestionSourceView {
  const view: Partial<ReturnType<typeof toSource>> = { ...source };
  delete view.ruleCurrentGated;
  return view as SuggestionSourceView;
}

async function loadSources(
  db: pg.Pool | pg.PoolClient,
  scope: BrandScope,
  ids: readonly string[],
): Promise<Map<string, ReturnType<typeof toSource>[]>> {
  const out = new Map<string, ReturnType<typeof toSource>[]>();
  if (ids.length === 0) return out;
  const { rows } = await db.query<SourceDb>(SOURCES_SQL, [
    scope.organizationId,
    scope.brandId,
    ids,
  ]);
  for (const r of rows) {
    const list = out.get(r.suggestion_id) ?? [];
    list.push(toSource(r));
    out.set(r.suggestion_id, list);
  }
  return out;
}

export class PgSuggestionStore {
  constructor(private readonly pool: pg.Pool) {}

  async propose(
    scope: ConnectionScope,
    i: {
      commentId: string;
      source: SuggestionSourceInput;
      steps: readonly GatedStep[];
      reason: string;
    },
  ): Promise<
    | { suggestionId: string; created: boolean }
    | { skipped: 'comment_gone' | 'rule_inactive' | 'nothing_gated' }
  > {
    const { organizationId, brandId, connectionId } = scope;
    return withTransaction(this.pool, async (tx) => {
      const comment = await tx.query<{
        platform_state: string;
        author_id: string | null;
        sha: Buffer;
      }>(
        `SELECT c.platform_state, c.author_id, sha256(convert_to(c.body, 'UTF8')) AS sha
           FROM comment c
          WHERE c.organization_id = $1 AND c.brand_id = $2 AND c.connection_id = $3 AND c.id = $4
          FOR UPDATE`,
        [organizationId, brandId, connectionId, i.commentId],
      );
      const row = comment.rows[0];
      if (!row || row.platform_state === 'deleted') return { skipped: 'comment_gone' as const };
      if (i.steps.length === 0) return { skipped: 'nothing_gated' as const };

      if (i.source.type === 'rule') {
        const rule = await tx.query(
          `SELECT 1 FROM rule
            WHERE organization_id = $1 AND brand_id = $2 AND id = $3
              AND enabled AND archived_at IS NULL AND mode = 'enforce'
            FOR SHARE`,
          [organizationId, brandId, i.source.ruleId],
        );
        if (rule.rowCount === 0) return { skipped: 'rule_inactive' as const };
      }

      await tx.query(
        `UPDATE action_suggestion
            SET status = 'not_applicable', status_reason = 'comment_edited', decided_at = now()
          WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND comment_id = $4
            AND status = 'pending' AND body_sha256 <> $5`,
        [organizationId, brandId, connectionId, i.commentId, row.sha],
      );
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO action_suggestion (organization_id, brand_id, connection_id, comment_id, author_id, body_sha256)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (comment_id) WHERE status = 'pending' DO NOTHING
         RETURNING id`,
        [organizationId, brandId, connectionId, i.commentId, row.author_id, row.sha],
      );
      let suggestionId = inserted.rows[0]?.id;
      if (!suggestionId) {
        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM action_suggestion
            WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND comment_id = $4
              AND status = 'pending'`,
          [organizationId, brandId, connectionId, i.commentId],
        );
        suggestionId = existing.rows[0]!.id;
      }

      const rule = i.source.type === 'rule' ? i.source : null;
      await tx.query(
        `INSERT INTO action_suggestion_source (organization_id, brand_id, suggestion_id, source_type, source_ref,
                                               rule_id, also_matched_rule_ids, steps, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8::jsonb, $9)
         ON CONFLICT (suggestion_id, source_type, source_ref) DO NOTHING`,
        [
          organizationId,
          brandId,
          suggestionId,
          i.source.type,
          i.source.ref,
          rule?.ruleId ?? null,
          rule?.alsoMatchedRuleIds ?? [],
          JSON.stringify(i.steps),
          i.reason,
        ],
      );
      return { suggestionId, created: inserted.rows[0] !== undefined };
    });
  }

  /** Newest first; `before` is the id of the last item of the previous page. */
  async list(scope: BrandScope, f: SuggestionFilter, now: Date): Promise<SuggestionView[]> {
    const status = f.status ?? 'pending';
    const { rows } = await this.pool.query<SuggestionDb>(
      `WITH ${PENDING_CTES}
       SELECT e.id, e.connection_id, e.platform, e.comment_id, e.body, e.author_id, e.author_name,
              coalesce(p.n, 0) AS author_pending, e.eff_status, e.eff_reason, e.created_at, e.decided_at,
              e.decided_by_name, e.expires_at
         FROM eff e
         LEFT JOIN pend p ON p.connection_id = e.connection_id AND p.author_id = e.author_id
        WHERE ($4::text = 'all' OR e.eff_status = $4)
          AND ($5::uuid IS NULL OR e.connection_id = $5)
          AND ($6::uuid IS NULL OR e.author_id = $6)
          AND ($7::uuid IS NULL OR EXISTS (
                SELECT 1 FROM action_suggestion_source ss
                 WHERE ss.organization_id = $1 AND ss.brand_id = $2 AND ss.suggestion_id = e.id
                   AND ss.rule_id = $7))
          AND ($8::text IS NULL OR EXISTS (
                SELECT 1 FROM action_suggestion_source ss
                 WHERE ss.organization_id = $1 AND ss.brand_id = $2 AND ss.suggestion_id = e.id
                   AND ss.steps @> jsonb_build_array(jsonb_build_object('type', $8::text))))
          AND ($9::uuid IS NULL OR (e.created_at, e.id) < (
                SELECT b.created_at, b.id FROM action_suggestion b
                 WHERE b.organization_id = $1 AND b.brand_id = $2 AND b.id = $9))
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $10`,
      [
        scope.organizationId,
        scope.brandId,
        now,
        status,
        f.connectionId ?? null,
        f.authorId ?? null,
        f.ruleId ?? null,
        f.stepType ?? null,
        f.before ?? null,
        clampLimit(f.limit),
      ],
    );
    return this.toViews(scope, rows);
  }

  /** Oldest first; `total` counts every match, not just the returned ids. */
  async matchPending(
    scope: ConnectionScope,
    f: { [K in 'ruleId' | 'authorId' | 'stepType']?: SuggestionFilter[K] | undefined },
    cutoff: Date,
    now: Date,
    limit: number,
  ): Promise<{ ids: string[]; total: number }> {
    const { rows } = await this.pool.query<{ id: string; total: number }>(
      `WITH eff AS (${EFFECTIVE_SQL})
       SELECT e.id, count(*) OVER ()::int AS total
         FROM eff e
        WHERE e.eff_status = 'pending' AND e.connection_id = $4 AND e.created_at <= $5
          AND ($6::uuid IS NULL OR e.author_id = $6)
          AND ($7::uuid IS NULL OR EXISTS (
                SELECT 1 FROM action_suggestion_source ss
                 WHERE ss.organization_id = $1 AND ss.brand_id = $2 AND ss.suggestion_id = e.id
                   AND ss.rule_id = $7))
          AND ($8::text IS NULL OR EXISTS (
                SELECT 1 FROM action_suggestion_source ss
                 WHERE ss.organization_id = $1 AND ss.brand_id = $2 AND ss.suggestion_id = e.id
                   AND ss.steps @> jsonb_build_array(jsonb_build_object('type', $8::text))))
        ORDER BY e.created_at, e.id
        LIMIT $9`,
      [
        scope.organizationId,
        scope.brandId,
        now,
        scope.connectionId,
        cutoff,
        f.authorId ?? null,
        f.ruleId ?? null,
        f.stepType ?? null,
        limit,
      ],
    );
    return { ids: rows.map((r) => r.id), total: rows[0]?.total ?? 0 };
  }

  async load(scope: BrandScope, id: string, now: Date): Promise<SuggestionView | null> {
    const { rows } = await this.pool.query<SuggestionDb>(
      `WITH ${PENDING_CTES}
       SELECT e.id, e.connection_id, e.platform, e.comment_id, e.body, e.author_id, e.author_name,
              coalesce(p.n, 0) AS author_pending, e.eff_status, e.eff_reason, e.created_at, e.decided_at,
              e.decided_by_name, e.expires_at
         FROM eff e
         LEFT JOIN pend p ON p.connection_id = e.connection_id AND p.author_id = e.author_id
        WHERE e.id = $4`,
      [scope.organizationId, scope.brandId, now, id],
    );
    return (await this.toViews(scope, rows))[0] ?? null;
  }

  async pendingAuthors(
    scope: BrandScope,
    connectionId: string,
    limit: number,
  ): Promise<{ authorId: string; authorName: string | null; pendingCount: number }[]> {
    const { rows } = await this.pool.query<{
      author_id: string;
      author_name: string | null;
      n: number;
    }>(
      `WITH ${PENDING_CTES}
       SELECT p.author_id, au.display_name AS author_name, p.n
         FROM pend p
         JOIN author au ON au.organization_id = $1 AND au.brand_id = $2
                       AND au.connection_id = p.connection_id AND au.id = p.author_id
        WHERE p.connection_id = $4 AND p.n >= 2
        ORDER BY p.n DESC, p.author_id
        LIMIT $5`,
      [scope.organizationId, scope.brandId, new Date(), connectionId, clampLimit(limit)],
    );
    return rows.map((r) => ({
      authorId: r.author_id,
      authorName: r.author_name,
      pendingCount: r.n,
    }));
  }

  async pendingCount(scope: BrandScope, connectionId?: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      `WITH eff AS (${EFFECTIVE_SQL})
       SELECT count(*)::int AS n FROM eff
        WHERE eff_status = 'pending' AND ($4::uuid IS NULL OR connection_id = $4)`,
      [scope.organizationId, scope.brandId, new Date(), connectionId ?? null],
    );
    return rows[0]!.n;
  }

  async lockForDecision(
    tx: pg.PoolClient,
    scope: BrandScope,
    id: string,
  ): Promise<LockedSuggestion | null> {
    const { rows } = await tx.query<{
      id: string;
      connection_id: string;
      comment_id: string;
      status: SuggestionStatus;
      request_key: string | null;
      decided_at: Date | null;
      decided_by_name: string | null;
      comment_state: 'visible' | 'hidden' | 'deleted' | null;
      body_changed: boolean;
      connection_status: ConnectionStatus;
      review_mode: ReviewMode;
      review_mode_started_at: Date | null;
      review_mode_ends_at: Date | null;
      review_mode_ended_at: Date | null;
    }>(
      `SELECT s.id, s.connection_id, s.comment_id, s.status, s.request_key, s.decided_at,
              u.display_name AS decided_by_name, c.platform_state AS comment_state,
              coalesce(${BODY_CHANGED_SQL}, false) AS body_changed, cn.status AS connection_status,
              cn.review_mode, cn.review_mode_started_at, cn.review_mode_ends_at, cn.review_mode_ended_at
         FROM action_suggestion s
         JOIN connection cn ON cn.organization_id = s.organization_id AND cn.brand_id = s.brand_id AND cn.id = s.connection_id
         LEFT JOIN comment c ON c.organization_id = s.organization_id AND c.brand_id = s.brand_id AND c.id = s.comment_id
         LEFT JOIN app_user u ON u.id = s.decided_by_user_id
        WHERE s.organization_id = $1 AND s.brand_id = $2 AND s.id = $3
          FOR UPDATE OF s`,
      [scope.organizationId, scope.brandId, id],
    );
    const r = rows[0];
    if (!r) return null;
    const sources = await loadSources(tx, scope, [id]);
    return {
      id: r.id,
      connectionId: r.connection_id,
      commentId: r.comment_id,
      status: r.status,
      requestKey: r.request_key,
      decidedAt: r.decided_at,
      decidedByName: r.decided_by_name,
      commentState: r.comment_state,
      bodyChanged: r.body_changed,
      connectionStatus: r.connection_status,
      reviewMode: {
        mode: r.review_mode,
        startedAt: r.review_mode_started_at,
        endsAt: r.review_mode_ends_at,
        endedAt: r.review_mode_ended_at,
      },
      sources: sources.get(id) ?? [],
    };
  }

  /** Only while pending; false otherwise or when not in scope. */
  async decide(
    tx: pg.PoolClient,
    scope: BrandScope,
    id: string,
    d: {
      status: Exclude<SuggestionStatus, 'pending'>;
      reason: string | null;
      userId: string | null;
      requestKey: string | null;
    },
  ): Promise<boolean> {
    const res = await tx.query(
      `UPDATE action_suggestion
          SET status = $4, status_reason = $5, decided_by_user_id = $6, request_key = $7, decided_at = now()
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND status = 'pending'`,
      [scope.organizationId, scope.brandId, id, d.status, d.reason, d.userId, d.requestKey],
    );
    return res.rowCount === 1;
  }

  /** Rule edits and retirements reach the pending suggestions that rule contributed to. */
  async onRuleChanged(
    tx: pg.PoolClient,
    scope: BrandScope,
    ruleId: string,
    change: 'retired' | { actions: readonly ActionStep[] },
  ): Promise<{ withdrawn: number; updated: number }> {
    const gated = change === 'retired' ? [] : splitGated(change.actions).gated;
    let updated = 0;
    if (gated.length > 0) {
      const res = await tx.query(
        `UPDATE action_suggestion_source ss SET steps = $4::jsonb
           FROM action_suggestion s
          WHERE ss.organization_id = $1 AND ss.brand_id = $2 AND ss.rule_id = $3
            AND s.organization_id = ss.organization_id AND s.brand_id = ss.brand_id
            AND s.id = ss.suggestion_id AND s.status = 'pending'`,
        [scope.organizationId, scope.brandId, ruleId, JSON.stringify(gated)],
      );
      updated = res.rowCount ?? 0;
    } else {
      await tx.query(
        `DELETE FROM action_suggestion_source ss
          USING action_suggestion s
          WHERE ss.organization_id = $1 AND ss.brand_id = $2 AND ss.rule_id = $3
            AND s.organization_id = ss.organization_id AND s.brand_id = ss.brand_id
            AND s.id = ss.suggestion_id AND s.status = 'pending'`,
        [scope.organizationId, scope.brandId, ruleId],
      );
    }
    const withdrawn = await tx.query(
      `UPDATE action_suggestion s
          SET status = 'withdrawn', status_reason = 'rule_changed', decided_at = now()
        WHERE s.organization_id = $1 AND s.brand_id = $2 AND s.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM action_suggestion_source ss
                           WHERE ss.organization_id = s.organization_id AND ss.brand_id = s.brand_id
                             AND ss.suggestion_id = s.id)`,
      [scope.organizationId, scope.brandId],
    );
    return { withdrawn: withdrawn.rowCount ?? 0, updated };
  }

  private async toViews(scope: BrandScope, rows: SuggestionDb[]): Promise<SuggestionView[]> {
    const ids = rows.map((r) => r.id);
    const sources = await loadSources(this.pool, scope, ids);
    const runs = new Map<string, RunDb>();
    if (ids.length > 0) {
      const res = await this.pool.query<RunDb>(
        `SELECT r.suggestion_id, r.id AS run_id,
                coalesce((SELECT jsonb_agg(jsonb_build_object('type', st.step_type, 'status', st.status,
                                                              'reason', st.reason_code) ORDER BY st.position)
                            FROM action_run_step st
                           WHERE st.organization_id = r.organization_id AND st.brand_id = r.brand_id
                             AND st.run_id = r.id), '[]'::jsonb) AS steps
           FROM action_run r
          WHERE r.organization_id = $1 AND r.brand_id = $2 AND r.suggestion_id = ANY($3::uuid[])`,
        [scope.organizationId, scope.brandId, ids],
      );
      for (const r of res.rows) runs.set(r.suggestion_id, r);
    }
    return rows.map((r) => {
      const list = (sources.get(r.id) ?? []).map((source) => stripGated(source));
      const run = runs.get(r.id);
      return {
        id: r.id,
        connectionId: r.connection_id,
        platform: r.platform,
        commentId: r.comment_id,
        commentBody: r.body ?? '',
        authorId: r.author_id,
        authorName: r.author_name,
        authorPendingCount: r.author_pending,
        status: r.eff_status,
        statusReason: r.eff_reason,
        createdAt: r.created_at,
        decidedAt: r.decided_at,
        decidedByName: r.decided_by_name,
        expiresAt: r.expires_at,
        sources: list,
        plan: mergePlan(list.filter((s) => s.type !== 'rule' || s.ruleLive)),
        execution: run ? { runId: run.run_id, steps: run.steps } : null,
      };
    });
  }
}
