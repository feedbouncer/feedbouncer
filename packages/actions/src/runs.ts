// Durable action runs: one run per (rule evaluation, rule), one step row per configured
// step. Every statement filters organization_id + brand_id (plus connection_id where the
// scope has one) and is parameterised. Step config can hold reply template text and
// preview_text holds rendered reply text, so neither is ever logged.
import type pg from 'pg';
import { isUniqueViolation, withTransaction } from '@feedbouncer/db';
import type { ActionStatus, BrandScope } from '@feedbouncer/comments';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { clampLimit } from './support.js';
import { sortSteps, type ActionStep, type StepStatus, type StepType } from './steps.js';

export interface StepRow {
  id: string;
  runId: string;
  position: number;
  type: StepType;
  config: ActionStep;
  status: StepStatus;
  reasonCode: string | null;
  requestKey: string | null;
  moderationActionId: string | null;
  reviewItemId: string | null;
  previewText: string | null;
  undoActionId: string | null;
  undoneAt: Date | null;
  completedAt: Date | null;
}

export interface RunRow {
  id: string;
  connectionId: string;
  commentId: string;
  ruleId: string;
  evaluationId: string;
  dryRun: boolean;
  completedAt: Date | null;
  steps: StepRow[];
}

export interface LogEntry extends StepRow {
  commentId: string;
  ruleId: string;
  ruleName: string;
  dryRun: boolean;
  createdAt: Date;
  actionStatus: ActionStatus | null;
  undoStatus: ActionStatus | null;
  undoable: boolean;
}

export type StepWithRun = StepRow & {
  commentId: string;
  connectionId: string;
  ruleId: string;
  dryRun: boolean;
  /** Status of the latest undo attempt's action, if there was one. */
  undoStatus: ActionStatus | null;
};

interface StepDb {
  id: string;
  run_id: string;
  position: number;
  step_type: StepType;
  config: ActionStep;
  status: StepStatus;
  reason_code: string | null;
  request_key: string | null;
  moderation_action_id: string | null;
  review_item_id: string | null;
  preview_text: string | null;
  undo_action_id: string | null;
  undone_at: Date | null;
  completed_at: Date | null;
}

const STEP_COLS = `s.id, s.run_id, s.position, s.step_type, s.config, s.status, s.reason_code, s.request_key,
  s.moderation_action_id, s.review_item_id, s.preview_text, s.undo_action_id, s.undone_at, s.completed_at`;

const toStep = (r: StepDb): StepRow => ({
  id: r.id,
  runId: r.run_id,
  position: r.position,
  type: r.step_type,
  config: r.config,
  status: r.status,
  reasonCode: r.reason_code,
  requestKey: r.request_key,
  moderationActionId: r.moderation_action_id,
  reviewItemId: r.review_item_id,
  previewText: r.preview_text,
  undoActionId: r.undo_action_id,
  undoneAt: r.undone_at,
  completedAt: r.completed_at,
});

interface RunDb {
  id: string;
  connection_id: string;
  comment_id: string;
  rule_id: string;
  rule_evaluation_id: string;
  dry_run: boolean;
  completed_at: Date | null;
}

const RUN_COLS = `r.id, r.connection_id, r.comment_id, r.rule_id, r.rule_evaluation_id, r.dry_run, r.completed_at`;

/** Undo statuses after which the step can be undone again. */
const RETRY_UNDO = `('failed', 'not_eligible')`;

/** Needs the step as s, its run as r and its undo action as u. */
const UNDOABLE_SQL = `(s.status = 'succeeded' AND NOT r.dry_run
  AND s.step_type IN ('hide', 'ban', 'flag_for_review')
  AND (s.step_type <> 'flag_for_review' OR EXISTS (
        SELECT 1 FROM review_item ri
         WHERE ri.organization_id = s.organization_id AND ri.brand_id = s.brand_id
           AND ri.id = s.review_item_id AND ri.status = 'open'))
  AND (s.undone_at IS NULL OR COALESCE(u.status IN ${RETRY_UNDO}, false)))`;

/** The pool, or a client already held (e.g. under the run lock). */
export type Queryable = Pick<pg.ClientBase, 'query'>;

async function loadRun(
  q: Queryable,
  scope: ConnectionScope,
  where: { id: string } | { evaluationId: string; ruleId: string },
  lock: boolean,
): Promise<RunRow | null> {
  const byId = 'id' in where;
  const run = await q.query<RunDb>(
    `SELECT ${RUN_COLS} FROM action_run r
      WHERE r.organization_id = $1 AND r.brand_id = $2 AND r.connection_id = $3
        AND ${byId ? 'r.id = $4' : 'r.rule_evaluation_id = $4 AND r.rule_id = $5'}
      ${lock ? 'FOR UPDATE' : ''}`,
    [
      scope.organizationId,
      scope.brandId,
      scope.connectionId,
      ...(byId ? [where.id] : [where.evaluationId, where.ruleId]),
    ],
  );
  const r = run.rows[0];
  if (!r) return null;
  const steps = await q.query<StepDb>(
    `SELECT ${STEP_COLS} FROM action_run_step s
      WHERE s.organization_id = $1 AND s.brand_id = $2 AND s.run_id = $3
      ORDER BY s.position`,
    [scope.organizationId, scope.brandId, r.id],
  );
  return {
    id: r.id,
    connectionId: r.connection_id,
    commentId: r.comment_id,
    ruleId: r.rule_id,
    evaluationId: r.rule_evaluation_id,
    dryRun: r.dry_run,
    completedAt: r.completed_at,
    steps: steps.rows.map(toStep),
  };
}

/** Moderation kinds a user reversal is looked up for. */
const REVERSAL = {
  hide: { apply: 'hide', reverse: 'unhide', step: 'hide', perAuthor: false },
  ban_author: { apply: 'ban_author', reverse: 'unban_author', step: 'ban', perAuthor: true },
} as const;

export class PgActionRunStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Idempotent on (evaluationId, ruleId); returns the existing run on conflict. */
  async createRun(
    scope: ConnectionScope,
    i: {
      commentId: string;
      ruleId: string;
      evaluationId: string;
      dryRun: boolean;
      steps: readonly ActionStep[];
    },
  ): Promise<RunRow> {
    return withTransaction(this.pool, async (tx) => {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO action_run (organization_id, brand_id, connection_id, comment_id, rule_id, rule_evaluation_id, dry_run)
         SELECT e.organization_id, e.brand_id, e.connection_id, e.comment_id, $5, e.id, $6
           FROM rule_evaluation e
          WHERE e.id = $4 AND e.organization_id = $1 AND e.brand_id = $2 AND e.connection_id = $3
            AND e.comment_id = $7
         ON CONFLICT (rule_evaluation_id, rule_id) DO NOTHING
         RETURNING id`,
        [
          scope.organizationId,
          scope.brandId,
          scope.connectionId,
          i.evaluationId,
          i.ruleId,
          i.dryRun,
          i.commentId,
        ],
      );
      const created = ins.rows[0];
      if (created) {
        const steps = sortSteps(i.steps);
        for (const [position, step] of steps.entries()) {
          await tx.query(
            `INSERT INTO action_run_step (organization_id, brand_id, run_id, position, step_type, config)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
              scope.organizationId,
              scope.brandId,
              created.id,
              position,
              step.type,
              JSON.stringify(step),
            ],
          );
        }
      }
      const run = await loadRun(
        tx,
        scope,
        created ? { id: created.id } : { evaluationId: i.evaluationId, ruleId: i.ruleId },
        false,
      );
      if (!run) throw new Error('evaluation_not_found');
      return run;
    });
  }

  async getRun(scope: ConnectionScope, runId: string): Promise<RunRow | null> {
    return loadRun(this.pool, scope, { id: runId }, false);
  }

  /** Runs fn inside a transaction holding the run row lock; null when the run is not in scope. */
  async withRunLocked<T>(
    scope: ConnectionScope,
    runId: string,
    fn: (tx: pg.PoolClient, run: RunRow) => Promise<T>,
  ): Promise<T | null> {
    return withTransaction(this.pool, async (tx) => {
      const run = await loadRun(tx, scope, { id: runId }, true);
      return run ? fn(tx, run) : null;
    });
  }

  /** Only moves a step that is still pending. */
  async settleStep(
    tx: pg.PoolClient,
    scope: BrandScope,
    stepId: string,
    o: { status: StepStatus; reason: string | null; reviewItemId?: string; previewText?: string },
  ): Promise<void> {
    await tx.query(
      `UPDATE action_run_step
          SET status = $4, reason_code = $5, review_item_id = $6, preview_text = $7, completed_at = now()
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND status = 'pending'`,
      [
        scope.organizationId,
        scope.brandId,
        stepId,
        o.status,
        o.reason,
        o.reviewItemId ?? null,
        o.previewText ?? null,
      ],
    );
  }

  /** Links the platform action; a savepoint keeps the transaction usable after a conflict. */
  async linkAction(
    tx: pg.PoolClient,
    scope: BrandScope,
    stepId: string,
    moderationActionId: string,
    requestKey: string,
  ): Promise<'linked' | 'owned_by_other_step'> {
    await tx.query('SAVEPOINT link_action');
    try {
      const r = await tx.query(
        `UPDATE action_run_step SET moderation_action_id = $4, request_key = $5
          WHERE organization_id = $1 AND brand_id = $2 AND id = $3`,
        [scope.organizationId, scope.brandId, stepId, moderationActionId, requestKey],
      );
      if (r.rowCount !== 1) throw new Error('step_not_found');
      await tx.query('RELEASE SAVEPOINT link_action');
      return 'linked';
    } catch (e) {
      await tx.query('ROLLBACK TO SAVEPOINT link_action');
      await tx.query('RELEASE SAVEPOINT link_action');
      if (isUniqueViolation(e, 'action_run_step_moderation_action_key'))
        return 'owned_by_other_step';
      throw e;
    }
  }

  async findStepByAction(
    scope: BrandScope,
    moderationActionId: string,
  ): Promise<{ runId: string; stepId: string; connectionId: string } | null> {
    const r = await this.pool.query<{ run_id: string; id: string; connection_id: string }>(
      `SELECT s.run_id, s.id, r.connection_id
         FROM action_run_step s
         JOIN action_run r ON r.brand_id = s.brand_id AND r.id = s.run_id
        WHERE s.organization_id = $1 AND s.brand_id = $2 AND s.moderation_action_id = $3
          AND r.organization_id = $1`,
      [scope.organizationId, scope.brandId, moderationActionId],
    );
    const row = r.rows[0];
    return row ? { runId: row.run_id, stepId: row.id, connectionId: row.connection_id } : null;
  }

  /** Records why a step is still waiting (e.g. rate_limited); only while it is pending. */
  async markStepWaiting(scope: BrandScope, stepId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE action_run_step SET reason_code = $4
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND status = 'pending'`,
      [scope.organizationId, scope.brandId, stepId, reason],
    );
  }

  /** Number of steps of the run that are no longer pending. */
  async countSettledSteps(scope: BrandScope, runId: string): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM action_run_step
        WHERE organization_id = $1 AND brand_id = $2 AND run_id = $3 AND status <> 'pending'`,
      [scope.organizationId, scope.brandId, runId],
    );
    return r.rows[0]?.n ?? 0;
  }

  async markRunCompleted(tx: pg.PoolClient, scope: BrandScope, runId: string): Promise<void> {
    await tx.query(
      `UPDATE action_run SET completed_at = now()
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND completed_at IS NULL`,
      [scope.organizationId, scope.brandId, runId],
    );
  }

  /**
   * True when a person has overruled an automated hide or ban: the latest live hide/unhide
   * (ban/unban across the author's comments on this connection) is a user's reversal, or a
   * step of that kind was undone from the log (an undo whose action failed does not count).
   */
  async hasUserReversal(
    scope: BrandScope,
    commentId: string,
    kind: 'hide' | 'ban_author',
    db: Queryable = this.pool,
  ): Promise<boolean> {
    const k = REVERSAL[kind];
    const r = await db.query<{ reversed: boolean }>(
      `WITH me AS (
         SELECT id, author_id, connection_id FROM comment
          WHERE organization_id = $1 AND brand_id = $2 AND id = $3
       ), cs AS (
         SELECT c.id FROM comment c JOIN me ON c.connection_id = me.connection_id
          WHERE c.organization_id = $1 AND c.brand_id = $2
            AND (c.id = me.id OR ($7::boolean AND me.author_id IS NOT NULL AND c.author_id = me.author_id))
       )
       SELECT (
         EXISTS (
           SELECT 1 FROM (
             SELECT a.kind, a.actor_type FROM moderation_action a
              WHERE a.organization_id = $1 AND a.brand_id = $2
                AND a.comment_id IN (SELECT id FROM cs)
                AND a.kind IN ($4, $5) AND a.status IN ('pending', 'applied')
              ORDER BY a.created_at DESC, a.id DESC LIMIT 1
           ) l WHERE l.kind = $5 AND l.actor_type = 'user'
         )
         OR EXISTS (
           SELECT 1 FROM action_run_step s
             JOIN action_run r ON r.brand_id = s.brand_id AND r.id = s.run_id
            WHERE s.organization_id = $1 AND s.brand_id = $2 AND r.organization_id = $1
              AND r.comment_id IN (SELECT id FROM cs)
              AND s.step_type = $6 AND s.undone_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM moderation_action u
                               WHERE u.organization_id = $1 AND u.brand_id = $2
                                 AND u.id = s.undo_action_id AND u.status IN ${RETRY_UNDO})
         )
       ) AS reversed`,
      [scope.organizationId, scope.brandId, commentId, k.apply, k.reverse, k.step, k.perAuthor],
    );
    return r.rows[0]?.reversed === true;
  }

  /** True when a non-user public reply is live on any comment in this comment's thread. */
  async hasAutomatedThreadReply(
    scope: BrandScope,
    commentId: string,
    db: Queryable = this.pool,
  ): Promise<boolean> {
    const r = await db.query<{ found: boolean }>(
      `WITH me AS (
         SELECT coalesce(parent_comment_id, id) AS root FROM comment
          WHERE organization_id = $1 AND brand_id = $2 AND id = $3
       )
       SELECT EXISTS (
         SELECT 1 FROM moderation_action a
           JOIN comment c ON c.brand_id = a.brand_id AND c.id = a.comment_id
           JOIN me ON coalesce(c.parent_comment_id, c.id) = me.root
          WHERE a.organization_id = $1 AND a.brand_id = $2 AND c.organization_id = $1
            AND a.kind = 'public_reply' AND a.actor_type <> 'user'
            AND a.status IN ('pending', 'applied')
       ) AS found`,
      [scope.organizationId, scope.brandId, commentId],
    );
    return r.rows[0]?.found === true;
  }

  /** Newest first; `before` is the id of the last step of the previous page. */
  async listLog(
    scope: BrandScope,
    f: {
      ruleId?: string;
      commentId?: string;
      status?: StepStatus;
      type?: StepType;
      before?: string;
      limit: number;
    },
  ): Promise<LogEntry[]> {
    const r = await this.pool.query<
      StepDb & {
        comment_id: string;
        rule_id: string;
        rule_name: string;
        dry_run: boolean;
        created_at: Date;
        action_status: ActionStatus | null;
        undo_status: ActionStatus | null;
        undoable: boolean;
      }
    >(
      `SELECT ${STEP_COLS}, r.comment_id, r.rule_id, ru.name AS rule_name, r.dry_run, s.created_at,
              a.status AS action_status, u.status AS undo_status, ${UNDOABLE_SQL} AS undoable
         FROM action_run_step s
         JOIN action_run r ON r.brand_id = s.brand_id AND r.id = s.run_id
         JOIN rule ru ON ru.organization_id = r.organization_id AND ru.brand_id = r.brand_id AND ru.id = r.rule_id
         LEFT JOIN moderation_action a ON a.organization_id = s.organization_id AND a.brand_id = s.brand_id
                                      AND a.id = s.moderation_action_id
         LEFT JOIN moderation_action u ON u.organization_id = s.organization_id AND u.brand_id = s.brand_id
                                      AND u.id = s.undo_action_id
        WHERE s.organization_id = $1 AND s.brand_id = $2 AND r.organization_id = $1
          AND ($3::uuid IS NULL OR r.rule_id = $3)
          AND ($4::uuid IS NULL OR r.comment_id = $4)
          AND ($5::text IS NULL OR s.status = $5)
          AND ($6::text IS NULL OR s.step_type = $6)
          AND ($7::uuid IS NULL OR (s.created_at, s.position, s.id) < (
                SELECT b.created_at, b.position, b.id FROM action_run_step b
                 WHERE b.organization_id = $1 AND b.brand_id = $2 AND b.id = $7))
        ORDER BY s.created_at DESC, s.position DESC, s.id DESC
        LIMIT $8`,
      [
        scope.organizationId,
        scope.brandId,
        f.ruleId ?? null,
        f.commentId ?? null,
        f.status ?? null,
        f.type ?? null,
        f.before ?? null,
        clampLimit(f.limit),
      ],
    );
    return r.rows.map((row) => ({
      ...toStep(row),
      commentId: row.comment_id,
      ruleId: row.rule_id,
      ruleName: row.rule_name,
      dryRun: row.dry_run,
      createdAt: row.created_at,
      actionStatus: row.action_status,
      undoStatus: row.undo_status,
      undoable: row.undoable,
    }));
  }

  async loadStep(scope: BrandScope, stepId: string): Promise<StepWithRun | null> {
    const r = await this.pool.query<
      StepDb & {
        comment_id: string;
        connection_id: string;
        rule_id: string;
        dry_run: boolean;
        undo_status: ActionStatus | null;
      }
    >(
      `SELECT ${STEP_COLS}, r.comment_id, r.connection_id, r.rule_id, r.dry_run, u.status AS undo_status
         FROM action_run_step s
         JOIN action_run r ON r.brand_id = s.brand_id AND r.id = s.run_id
         LEFT JOIN moderation_action u ON u.organization_id = s.organization_id AND u.brand_id = s.brand_id
                                      AND u.id = s.undo_action_id
        WHERE s.organization_id = $1 AND s.brand_id = $2 AND s.id = $3 AND r.organization_id = $1`,
      [scope.organizationId, scope.brandId, stepId],
    );
    const row = r.rows[0];
    return row
      ? {
          ...toStep(row),
          commentId: row.comment_id,
          connectionId: row.connection_id,
          ruleId: row.rule_id,
          dryRun: row.dry_run,
          undoStatus: row.undo_status,
        }
      : null;
  }

  /**
   * Records an undo attempt: its action becomes the step's undo action, and the step is
   * marked undone when `applied` (the action was accepted), or left not undone when the
   * action was refused at once. Compare-and-set on `previous`, the undo action the caller
   * saw: false when another attempt got there first, the step is not in scope, or it is not
   * a succeeded, live hide, ban or flag step. A step already undone can only be undone again
   * through a new attempt after its undo action failed.
   */
  async markUndone(
    tx: pg.PoolClient,
    scope: BrandScope,
    stepId: string,
    userId: string,
    undoActionId: string | null,
    o: { previous?: string | null; applied?: boolean } = {},
  ): Promise<boolean> {
    const applied = o.applied ?? true;
    const r = await tx.query(
      `UPDATE action_run_step s
          SET undo_action_id = $5,
              undone_at = CASE WHEN $7 THEN now() END,
              undone_by_user_id = CASE WHEN $7 THEN $4::uuid END
        WHERE s.organization_id = $1 AND s.brand_id = $2 AND s.id = $3
          AND s.undo_action_id IS NOT DISTINCT FROM $6::uuid
          AND (s.undone_at IS NULL OR s.undo_action_id IS NOT NULL)
          AND s.status = 'succeeded' AND s.step_type IN ('hide', 'ban', 'flag_for_review')
          AND EXISTS (SELECT 1 FROM action_run r
                       WHERE r.organization_id = $1 AND r.brand_id = $2 AND r.id = s.run_id
                         AND NOT r.dry_run)`,
      [
        scope.organizationId,
        scope.brandId,
        stepId,
        userId,
        undoActionId,
        o.previous ?? null,
        applied,
      ],
    );
    return r.rowCount === 1;
  }
}
