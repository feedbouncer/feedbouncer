// Moderator decisions on suggestions and the end of review mode. Every decision runs in one
// transaction holding the suggestion row lock, so two moderators cannot both win; the approval
// run is woken after commit, and replaying the same request key wakes it again. Scoping is by
// organization + brand (+ connection) on every query. Comment bodies are never logged.
import type pg from 'pg';
import * as z from 'zod';
import { withTransaction } from '@feedbouncer/db';
import { REQUEST_KEY, connectionRefusal, type BrandScope } from '@feedbouncer/comments';
import { graceEndsAt, type Clock } from '@feedbouncer/connectors';
import type { JobDefinition, JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import { UUID, type Logger } from '@feedbouncer/service-runtime';
import type { ActionRunner } from './runner.js';
import type { PgActionRunStore } from './runs.js';
import type { Audit } from './services.js';
import type { StepType } from './steps.js';
import {
  GATED_STEP_TYPES,
  mergePlan,
  needsConfirmation,
  type SuggestionStatus,
} from './suggestion-plan.js';
import type { LockedSuggestion, PgSuggestionStore, SuggestionFilter } from './suggestions.js';

export interface SuggestionServiceDeps {
  pool: pg.Pool;
  suggestions: PgSuggestionStore;
  runs: PgActionRunStore;
  runner: Pick<ActionRunner, 'wakeRun'>;
  producer: Pick<JobProducer, 'enqueue'>;
  audit: Audit;
  clock: Clock;
  log: Logger;
}
type Deps = SuggestionServiceDeps;

export type DecisionResult =
  | {
      status: 'approved';
      runId: string;
      steps: StepType[];
      dropped: { type: StepType; reason: string }[];
    }
  | { status: 'dismissed' }
  | { status: 'not_applicable'; reason: 'comment_gone' | 'comment_edited' }
  | { status: 'expired' }
  | { status: 'withdrawn' }
  | {
      status: 'refused';
      code:
        | 'not_found'
        | 'confirmation_required'
        | 'connection_needs_reconnect'
        | 'connection_inactive';
    }
  | {
      status: 'refused';
      code: 'already_handled';
      handled: { status: SuggestionStatus; decidedAt: Date | null; decidedByName: string | null };
    };

type BulkFilter = Omit<SuggestionFilter, 'status' | 'before' | 'limit' | 'connectionId'>;
type Action = 'approve' | 'dismiss';

interface Outcome {
  result: DecisionResult;
  wake?: { scope: ConnectionScope; runId: string };
}

const refused = (code: Extract<DecisionResult, { code: string }>['code']) =>
  ({ status: 'refused', code }) as DecisionResult;

const BULK_BATCH = 100;

async function decideLocked(
  d: Deps,
  scope: BrandScope,
  id: string,
  op: Action,
  i: { userId: string; requestKey: string },
  body: (tx: pg.PoolClient, s: LockedSuggestion, now: Date) => Promise<Outcome>,
): Promise<DecisionResult> {
  const now = new Date(d.clock.now());
  const out = await withTransaction(d.pool, async (tx): Promise<Outcome> => {
    const s = await d.suggestions.lockForDecision(tx, scope, id);
    if (!s) return { result: refused('not_found') };
    if (s.status === 'pending') return body(tx, s, now);
    const own = { ...scope, connectionId: s.connectionId };
    if (op === 'dismiss' && s.status === 'dismissed' && s.requestKey === i.requestKey)
      return { result: { status: 'dismissed' } };
    if (op === 'approve' && s.status === 'approved' && s.requestKey === i.requestKey) {
      const run = await d.runs.getSuggestionRun(own, id, tx);
      if (run)
        return {
          result: {
            status: 'approved',
            runId: run.id,
            steps: run.steps.map((st) => st.type),
            dropped: [],
          },
          wake: { scope: own, runId: run.id },
        };
    }
    return {
      result: {
        status: 'refused',
        code: 'already_handled',
        handled: { status: s.status, decidedAt: s.decidedAt, decidedByName: s.decidedByName },
      },
    };
  });
  if (out.wake) await d.runner.wakeRun(out.wake.scope, out.wake.runId);
  return out.result;
}

export function approveSuggestion(
  d: Deps,
  scope: BrandScope,
  id: string,
  i: { userId: string; requestKey: string; confirm?: boolean },
): Promise<DecisionResult> {
  return decideLocked(d, scope, id, 'approve', i, async (tx, s, now) => {
    const system = (status: 'expired' | 'not_applicable', reason: string): Promise<boolean> =>
      d.suggestions.decide(tx, scope, id, { status, reason, userId: null, requestKey: null });
    if (s.commentState === null || s.commentState === 'deleted') {
      await system('not_applicable', 'comment_gone');
      return { result: { status: 'not_applicable', reason: 'comment_gone' } };
    }
    if (s.bodyChanged) {
      await system('not_applicable', 'comment_edited');
      return { result: { status: 'not_applicable', reason: 'comment_edited' } };
    }
    const grace = graceEndsAt(s.reviewMode);
    if (grace && now.getTime() >= grace.getTime()) {
      await system('expired', 'grace_period_ended');
      return { result: { status: 'expired' } };
    }
    const refusal = connectionRefusal(s.connectionStatus);
    if (refusal) return { result: refused(refusal) };

    const plan = mergePlan(
      s.sources.flatMap((source) => {
        const steps = source.type === 'rule' ? source.ruleCurrentGated : source.steps;
        return steps && steps.length > 0 ? [{ createdAt: source.createdAt, steps }] : [];
      }),
    );
    if (plan.steps.length === 0) {
      await d.suggestions.decide(tx, scope, id, {
        status: 'withdrawn',
        reason: 'rule_changed',
        userId: null,
        requestKey: null,
      });
      return { result: { status: 'withdrawn' } };
    }
    if (needsConfirmation(plan.steps) && !i.confirm)
      return { result: refused('confirmation_required') };

    await d.suggestions.decide(tx, scope, id, {
      status: 'approved',
      reason: null,
      userId: i.userId,
      requestKey: i.requestKey,
    });
    const own = { ...scope, connectionId: s.connectionId };
    const run = await d.runs.createSuggestionRun(tx, own, {
      suggestionId: id,
      commentId: s.commentId,
      userId: i.userId,
      steps: plan.steps,
    });
    const steps = plan.steps.map((st) => st.type);
    await d.audit(tx, {
      ...scope,
      actorUserId: i.userId,
      action: 'suggestion.approved',
      subjectType: 'action_suggestion',
      subjectId: id,
      details: { suggestionId: id, steps: steps.join(','), sourceCount: s.sources.length },
    });
    return {
      result: { status: 'approved', runId: run.id, steps, dropped: plan.dropped },
      wake: { scope: own, runId: run.id },
    };
  });
}

export function dismissSuggestion(
  d: Deps,
  scope: BrandScope,
  id: string,
  i: { userId: string; requestKey: string },
): Promise<DecisionResult> {
  return decideLocked(d, scope, id, 'dismiss', i, async (tx) => {
    await d.suggestions.decide(tx, scope, id, {
      status: 'dismissed',
      reason: null,
      userId: i.userId,
      requestKey: i.requestKey,
    });
    await d.audit(tx, {
      ...scope,
      actorUserId: i.userId,
      action: 'suggestion.dismissed',
      subjectType: 'action_suggestion',
      subjectId: id,
      details: { suggestionId: id },
    });
    return { result: { status: 'dismissed' } };
  });
}

const decide = (
  d: Deps,
  scope: BrandScope,
  id: string,
  i: { action: Action; userId: string; requestKey: string; confirm?: boolean },
): Promise<DecisionResult> =>
  i.action === 'approve' ? approveSuggestion(d, scope, id, i) : dismissSuggestion(d, scope, id, i);

export async function bulkDecide(
  d: Deps,
  scope: BrandScope,
  i: {
    action: Action;
    ids: string[];
    userId: string;
    requestKey: string;
    confirm?: boolean;
  },
): Promise<{ id: string; result: DecisionResult }[]> {
  const known = await d.pool.query<{ id: string; connection_id: string }>(
    `SELECT id, connection_id FROM action_suggestion
      WHERE organization_id = $1 AND brand_id = $2 AND id = ANY($3::uuid[])`,
    [scope.organizationId, scope.brandId, i.ids],
  );
  const connectionOf = new Map(known.rows.map((r) => [r.id, r.connection_id]));
  const refusedConnections = new Map<string, DecisionResult>();
  const out: { id: string; result: DecisionResult }[] = [];
  for (const id of i.ids) {
    const connectionId = connectionOf.get(id);
    const connectionRefused = connectionId ? refusedConnections.get(connectionId) : undefined;
    if (connectionRefused) {
      out.push({ id, result: connectionRefused });
      continue;
    }
    const result = await decide(d, scope, id, { ...i, requestKey: `${i.requestKey}:${id}` });
    if (
      connectionId &&
      result.status === 'refused' &&
      (result.code === 'connection_needs_reconnect' || result.code === 'connection_inactive')
    )
      refusedConnections.set(connectionId, result);
    out.push({ id, result });
  }
  return out;
}

export const SUGGESTION_BULK_JOB = {
  type: 'suggestion_bulk_apply' as const,
  platforms: ['facebook', 'instagram'] as const,
  payload: z.strictObject({
    action: z.enum(['approve', 'dismiss']),
    filter: z.strictObject({
      ruleId: z.string().regex(UUID).optional(),
      authorId: z.string().regex(UUID).optional(),
      stepType: z.enum(GATED_STEP_TYPES).optional(),
    }),
    userId: z.string().regex(UUID),
    requestKey: z.string().regex(REQUEST_KEY),
    confirm: z.boolean(),
    cutoff: z.iso.datetime(),
    batch: z.number().int().min(0).max(100_000),
    after: z.string().regex(UUID).optional(),
  }),
  externalRef: (p: { requestKey: string; batch: number }): string =>
    `sbulk:${p.requestKey}:${p.batch}`,
};
export type SuggestionBulkPayload = z.infer<typeof SUGGESTION_BULK_JOB.payload>;

export async function requestBulkByFilter(
  d: Deps,
  scope: ConnectionScope,
  i: {
    action: Action;
    filter: BulkFilter;
    userId: string;
    requestKey: string;
    confirm?: boolean;
  },
): Promise<{ matched: number }> {
  const conn = await d.pool.query<{ platform: 'facebook' | 'instagram' }>(
    'SELECT platform FROM connection WHERE organization_id = $1 AND brand_id = $2 AND id = $3',
    [scope.organizationId, scope.brandId, scope.connectionId],
  );
  const platform = conn.rows[0]?.platform;
  if (!platform) return { matched: 0 };
  const now = new Date(d.clock.now());
  const { total } = await d.suggestions.matchPending(scope, i.filter, now, now, 1);
  await withTransaction(d.pool, (tx) =>
    d.audit(tx, {
      ...scope,
      actorUserId: i.userId,
      action: 'suggestion.bulk_requested',
      subjectType: 'connection',
      subjectId: scope.connectionId,
      details: {
        bulkAction: i.action,
        matched: total,
        ruleId: i.filter.ruleId ?? null,
        authorId: i.filter.authorId ?? null,
        stepType: i.filter.stepType ?? null,
      },
    }),
  );
  if (total > 0)
    await d.producer.enqueue({
      scope,
      platform,
      type: SUGGESTION_BULK_JOB.type,
      payload: {
        action: i.action,
        filter: i.filter,
        userId: i.userId,
        requestKey: i.requestKey,
        confirm: i.confirm ?? false,
        cutoff: now.toISOString(),
        batch: 0,
      },
    });
  return { matched: total };
}

export function suggestionBulkJob(d: Deps): JobDefinition<SuggestionBulkPayload> {
  return {
    ...SUGGESTION_BULK_JOB,
    handle: async (ctx, p) => {
      const now = new Date(d.clock.now());
      const { ids } = await d.suggestions.matchPending(
        ctx.scope,
        p.filter,
        new Date(p.cutoff),
        now,
        BULK_BATCH,
        p.after,
      );
      let decided = 0;
      let stopped = false;
      for (const id of ids) {
        const result = await decide(d, ctx.scope, id, {
          action: p.action,
          userId: p.userId,
          requestKey: `${p.requestKey}:${id}`,
          confirm: p.confirm,
        });
        if (
          result.status === 'refused' &&
          (result.code === 'connection_needs_reconnect' || result.code === 'connection_inactive')
        ) {
          stopped = true;
          break;
        }
        if (result.status !== 'refused') decided += 1;
      }
      d.log.info('suggestion_bulk.batch', {
        batch: p.batch,
        processed: ids.length,
        decided,
        stopped,
      });
      if (!stopped && ids.length === BULK_BATCH)
        await d.producer.enqueue({
          scope: ctx.scope,
          platform: ctx.platform,
          type: SUGGESTION_BULK_JOB.type,
          payload: { ...p, batch: p.batch + 1, after: ids[ids.length - 1]! },
        });
      return { processed: ids.length, decided };
    },
  };
}

export async function endReviewModeEarly(
  d: Deps,
  scope: ConnectionScope,
  i: { userId: string; pending: 'leave' | 'dismiss' | 'approve'; confirm?: boolean },
): Promise<
  | { status: 'ended'; pendingCount: number }
  | { status: 'refused'; code: 'review_mode_not_active' | 'confirmation_required' }
> {
  if (i.pending === 'approve' && !i.confirm)
    return { status: 'refused', code: 'confirmation_required' };
  const now = new Date(d.clock.now());
  const pendingCount = await withTransaction(d.pool, async (tx) => {
    const ended = await tx.query(
      `UPDATE connection SET review_mode_ended_at = GREATEST($4, review_mode_started_at), review_mode_ended_by_user_id = $5,
              review_mode_ended_pending = $6
        WHERE organization_id = $1 AND brand_id = $2 AND id = $3
          AND review_mode = 'on' AND review_mode_started_at IS NOT NULL
          AND review_mode_ended_at IS NULL AND (review_mode_ends_at IS NULL OR review_mode_ends_at > $4)`,
      [scope.organizationId, scope.brandId, scope.connectionId, now, i.userId, i.pending],
    );
    if (ended.rowCount !== 1) return null;
    const scopeArgs = [scope.organizationId, scope.brandId, scope.connectionId];
    if (i.pending === 'dismiss')
      await tx.query(
        `UPDATE action_suggestion s
            SET status = 'not_applicable', decided_at = now(),
                status_reason = CASE WHEN c.platform_state = 'deleted' THEN 'comment_gone'
                                     ELSE 'comment_edited' END
           FROM comment c
          WHERE s.organization_id = $1 AND s.brand_id = $2 AND s.connection_id = $3
            AND s.status = 'pending'
            AND c.organization_id = s.organization_id AND c.brand_id = s.brand_id
            AND c.id = s.comment_id
            AND (c.platform_state = 'deleted'
                 OR sha256(convert_to(c.body, 'UTF8')) <> s.body_sha256)`,
        scopeArgs,
      );
    const count =
      i.pending === 'dismiss'
        ? ((
            await tx.query(
              `UPDATE action_suggestion
                  SET status = 'dismissed', status_reason = 'review_mode_ended', decided_by_user_id = $4,
                      decided_at = now()
                WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND status = 'pending'`,
              [...scopeArgs, i.userId],
            )
          ).rowCount ?? 0)
        : (
            await tx.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM action_suggestion
                WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND status = 'pending'`,
              scopeArgs,
            )
          ).rows[0]!.n;
    await d.audit(tx, {
      ...scope,
      actorUserId: i.userId,
      action: 'review_mode.ended_early',
      subjectType: 'connection',
      subjectId: scope.connectionId,
      details: { pending: i.pending, pendingCount: count },
    });
    return count;
  });
  const approveAll = () =>
    requestBulkByFilter(d, scope, {
      action: 'approve',
      filter: {},
      userId: i.userId,
      requestKey: `review_end:${scope.connectionId}`,
      confirm: true,
    });
  if (pendingCount === null) {
    // Ended early with approve but the enqueue failed: the retry enqueues again.
    if (i.pending === 'approve' && (await endedEarlyWithApprove(d.pool, scope)))
      return { status: 'ended', pendingCount: (await approveAll()).matched };
    return { status: 'refused', code: 'review_mode_not_active' };
  }
  if (i.pending === 'approve') await approveAll();
  return { status: 'ended', pendingCount };
}

async function endedEarlyWithApprove(pool: pg.Pool, scope: ConnectionScope): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM connection
      WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND review_mode_ended_pending = 'approve'`,
    [scope.organizationId, scope.brandId, scope.connectionId],
  );
  return rowCount === 1;
}
