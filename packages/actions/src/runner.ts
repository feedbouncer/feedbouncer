// Executes the steps of an action run in order. Each platform step goes through
// ModerationActions with the key `auto:<commentId>:<kind>`, so a comment is never
// hidden, banned or replied to twice. Reply text, author names and comment bodies are
// never logged.
import type pg from 'pg';
import type { Clock, Platform } from '@feedbouncer/connectors';
import {
  eligibilityComment,
  evaluateEligibility,
  type ActionKind,
  type ActionOutcomeObserver,
  type ModerationActionView,
  type BrandScope,
  type CommentRow,
  type ModerationActions,
  type PgCommentStore,
} from '@feedbouncer/comments';
import type { JobDefinition, JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import { ACTION_RUN_ADVANCE_JOB, type ActionRunAdvancePayload } from './jobs/specs.js';
import type { PgReviewQueue } from './review.js';
import type { PgActionRunStore, Queryable, RunRow, StepRow } from './runs.js';
import {
  MODERATION_KIND,
  sortSteps,
  type ActionStep,
  type StepStatus,
  type StepType,
} from './steps.js';
import {
  stepOutcomeFor,
  stepSupport,
  type BrandConnectionInfo,
  type StepOutcome,
} from './support.js';
import { renderTemplate } from './templates.js';

export interface ActionStepObserver {
  /** Told when a step settles. Delivery is at least once: must be idempotent. */
  onStepSettled(e: {
    scope: ConnectionScope;
    runId: string;
    stepId: string;
    ruleId: string;
    evaluationId: string;
    commentId: string;
    type: StepType;
    status: StepStatus;
    reason: string | null;
  }): Promise<void>;
}

export interface SimulatedStep {
  type: StepType;
  status: StepOutcome['status'];
  reason: string | null;
  previewText: string | null;
}

interface Requested {
  stepId: string;
  requestKey: string;
  result: Awaited<ReturnType<ModerationActions['request']>>;
}
interface PendingRequest {
  step: StepRow;
  kind: ActionKind;
  requestKey: string;
  text: string | undefined;
}
type Producer = Pick<JobProducer, 'enqueue'>;
type Settled = Parameters<ActionStepObserver['onStepSettled']>[0];

const PLATFORM_NAME: Partial<Record<Platform, string>> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
};
const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'NonError');
const WOULD_RUN: StepOutcome = { status: 'succeeded', reason: 'would_run' };

/**
 * One key per comment and kind, so automation never repeats an action. An attempt that
 * failed or was refused does not count: the next evaluation gets a new key and tries again.
 */
function automatedRequestKey(
  commentId: string,
  kind: ActionKind,
  views: readonly ModerationActionView[],
): string {
  const spent = views.filter(
    (v) =>
      v.kind === kind &&
      v.actorType !== 'user' &&
      (v.status === 'failed' || v.status === 'not_eligible'),
  ).length;
  return `auto:${commentId}:${kind}${spent > 0 ? `:${spent}` : ''}`;
}

function wake(
  producer: Producer,
  scope: ConnectionScope,
  platform: Platform,
  payload: ActionRunAdvancePayload,
) {
  return producer.enqueue({ scope, platform, type: ACTION_RUN_ADVANCE_JOB.type, payload });
}

export class ActionRunner {
  constructor(
    private readonly d: {
      pool: pg.Pool;
      runs: PgActionRunStore;
      review: PgReviewQueue;
      comments: PgCommentStore;
      actions: Pick<ModerationActions, 'request' | 'list'>;
      connection: (scope: ConnectionScope) => Promise<BrandConnectionInfo | null>;
      brandName: (scope: BrandScope) => Promise<string>;
      producer: Producer;
      clock: Clock;
      log: Logger;
      observer?: ActionStepObserver;
    },
  ) {}

  /** Creates the run (idempotent). A dry run is simulated and completed here; otherwise advance is queued. */
  async start(
    scope: ConnectionScope,
    i: {
      commentId: string;
      ruleId: string;
      evaluationId: string;
      dryRun: boolean;
      steps: readonly ActionStep[];
    },
  ): Promise<RunRow> {
    const run = await this.d.runs.createRun(scope, i);
    if (run.completedAt) return run;
    if (i.dryRun) {
      await this.#completeDryRun(scope, run);
      return run;
    }
    const comment = await this.d.comments.load(scope, i.commentId);
    if (!comment) throw new Error('comment_not_found');
    await wake(this.d.producer, scope, comment.platform, { runId: run.id, settled: 0 });
    return run;
  }

  async advance(
    scope: ConnectionScope,
    runId: string,
  ): Promise<{ settled: number; completed: boolean }> {
    // The run lock holds a pool client, so nothing under it may take another one: loads
    // happen before each locked pass and platform requests between passes.
    const first = await this.d.runs.getRun(scope, runId);
    if (!first) return { settled: 0, completed: false };
    const comment = await this.d.comments.load(scope, first.commentId);
    const conn = await this.d.connection(scope);
    const brand = await this.d.brandName(scope);
    let requested: Requested | undefined;
    for (;;) {
      const views = new Map(
        (await this.d.actions.list(scope, first.commentId)).map((v) => [v.id, v] as const),
      );
      const done = await this.d.runs.withRunLocked(scope, runId, (tx, run) =>
        this.#advanceLocked(tx, scope, run, { comment, conn, brand, views, requested }),
      );
      if (!done) return { settled: 0, completed: false };
      for (const e of done.events) await this.#notify(e);
      if (done.next) {
        requested = {
          stepId: done.next.step.id,
          requestKey: done.next.requestKey,
          result: await this.#request(scope, done.run, done.next),
        };
        continue;
      }
      await this.#wakeIfAlreadyFinal(scope, done);
      return { settled: done.final, completed: done.completed };
    }
  }

  async simulate(
    scope: ConnectionScope,
    commentId: string,
    steps: readonly ActionStep[],
  ): Promise<SimulatedStep[]> {
    const comment = await this.d.comments.load(scope, commentId);
    const conn = await this.d.connection(scope);
    const brand = await this.d.brandName(scope);
    const views = await this.d.actions.list(scope, commentId);
    const out: SimulatedStep[] = [];
    for (const step of sortSteps(steps)) {
      const previewText =
        'template' in step && comment && conn ? this.#render(step, comment, brand, conn) : null;
      const o = await this.#precheck(scope, step.type, comment, conn, views);
      out.push({ type: step.type, ...(o ?? this.#predict(step, comment!, conn!)), previewText });
    }
    return out;
  }

  async #completeDryRun(scope: ConnectionScope, run: RunRow): Promise<void> {
    const sim = await this.simulate(
      scope,
      run.commentId,
      run.steps.map((s) => s.config),
    );
    await this.d.runs.withRunLocked(scope, run.id, async (tx, locked) => {
      for (const [idx, step] of locked.steps.entries()) {
        const s = sim[idx]!;
        await this.d.runs.settleStep(tx, scope, step.id, {
          status: 'simulated',
          reason: s.reason,
          ...(s.previewText !== null && { previewText: s.previewText }),
        });
      }
      await this.d.runs.markRunCompleted(tx, scope, run.id);
    });
  }

  #render(
    step: ActionStep & { template: string },
    comment: CommentRow,
    brand: string,
    conn: BrandConnectionInfo,
  ): string {
    return renderTemplate(step.template, {
      author_name: comment.authorName,
      brand_name: brand,
      platform: PLATFORM_NAME[conn.platform] ?? null,
    });
  }

  /** What the platform would answer, judged from the stored comment. */
  #predict(step: ActionStep, comment: CommentRow, conn: BrandConnectionInfo): StepOutcome {
    if (step.type === 'flag_for_review') return WOULD_RUN;
    const e = evaluateEligibility({
      kind: MODERATION_KIND[step.type],
      actorType: 'rule',
      comment: eligibilityComment(comment),
      caps: conn.caps,
      now: new Date(this.d.clock.now()),
    });
    if (e.verdict === 'ok') return WOULD_RUN;
    if (e.verdict === 'unsupported') return { status: 'not_supported', reason: 'unsupported' };
    return stepOutcomeFor({ kind: 'action', status: e.verdict, code: e.code });
  }

  /** Reasons a step cannot run at all, checked in a fixed order; null when it can. */
  async #precheck(
    scope: ConnectionScope,
    type: StepType,
    comment: CommentRow | null,
    conn: BrandConnectionInfo | null,
    views: readonly ModerationActionView[],
    db?: Queryable,
  ): Promise<StepOutcome | null> {
    if (!comment) return { status: 'not_applicable', reason: 'comment_gone' };
    if (comment.isOwnAccount) return { status: 'skipped', reason: 'own_account_comment' };
    if (!conn) return { status: 'failed', reason: 'connection_inactive' };
    const support = stepSupport(type, conn);
    if (!support.supported) return { status: 'not_supported', reason: 'unsupported' };
    if (support.missingScopes.length > 0) return { status: 'failed', reason: 'missing_permission' };
    if (type === 'hide' || type === 'ban') {
      const kind = type === 'hide' ? 'hide' : 'ban_author';
      if (await this.d.runs.hasUserReversal(scope, comment.id, kind, db))
        return { status: 'skipped', reason: 'moderator_override' };
    }
    if (type === 'auto_reply' && (await this.#threadLimited(scope, comment.id, views, db)))
      return { status: 'skipped', reason: 'reply_thread_limit' };
    if (type === 'flag_for_review') return null;
    const ownAction = views.some(
      (v) => v.kind === MODERATION_KIND[type] && v.actorType !== 'user' && v.status !== 'failed',
    );
    if (comment.platformState === 'deleted' && type !== 'ban' && !ownAction)
      return { status: 'not_applicable', reason: 'comment_gone' };
    return null;
  }

  /** Another comment of the thread has an automated reply. This comment's own one is the duplicate case. */
  async #threadLimited(
    scope: ConnectionScope,
    commentId: string,
    views: readonly ModerationActionView[],
    db?: Queryable,
  ): Promise<boolean> {
    const hasOwnReply = views.some(
      (v) =>
        v.kind === 'public_reply' &&
        v.actorType !== 'user' &&
        (v.status === 'pending' || v.status === 'applied'),
    );
    return !hasOwnReply && (await this.d.runs.hasAutomatedThreadReply(scope, commentId, db));
  }

  async #advanceLocked(
    tx: pg.PoolClient,
    scope: ConnectionScope,
    run: RunRow,
    ld: {
      comment: CommentRow | null;
      conn: BrandConnectionInfo | null;
      brand: string;
      views: Map<string, ModerationActionView>;
      requested: Requested | undefined;
    },
  ) {
    const { runs } = this.d;
    const { comment, conn, brand, views } = ld;
    const events: Settled[] = [];
    const waiting: { step: StepRow; actionId: string }[] = [];
    let next: PendingRequest | null = null;
    let open = run.steps.filter((s) => s.status === 'pending').length;

    const settle = async (step: StepRow, o: StepOutcome, extra: { reviewItemId?: string } = {}) => {
      if (o.status === 'pending') return;
      await runs.settleStep(tx, scope, step.id, { status: o.status, reason: o.reason, ...extra });
      open -= 1;
      events.push({
        scope,
        runId: run.id,
        stepId: step.id,
        ruleId: run.ruleId,
        evaluationId: run.evaluationId,
        commentId: run.commentId,
        type: step.type,
        status: o.status,
        reason: o.reason,
      });
    };
    const settleAction = async (step: StepRow, actionId: string) => {
      const v = views.get(actionId);
      const o = v && stepOutcomeFor({ kind: 'action', status: v.status, code: v.outcomeCode });
      if (!o || o.status === 'pending') waiting.push({ step, actionId });
      else await settle(step, o);
    };

    for (const step of run.steps) {
      if (step.status !== 'pending') continue;
      // Delete is irreversible: it waits for every earlier step to be final.
      if (step.type === 'delete' && open > 1) break;
      if (step.moderationActionId) {
        await settleAction(step, step.moderationActionId);
        continue;
      }
      // The step requested in the previous pass is linked whatever the precheck says now:
      // its action already went out, so skipping it would leave that action unrecorded.
      const justRequested = ld.requested?.stepId === step.id;
      const blocked = justRequested
        ? null
        : await this.#precheck(scope, step.type, comment, conn, [...views.values()], tx);
      if (blocked) {
        await settle(step, blocked);
        continue;
      }
      if (step.type === 'flag_for_review') {
        await this.#flag(tx, scope, run, step, settle);
        continue;
      }
      const type = step.type as Exclude<StepType, 'flag_for_review'>;
      const kind = MODERATION_KIND[type];
      if (!justRequested) {
        const requestKey = automatedRequestKey(run.commentId, kind, [...views.values()]);
        const text =
          'template' in step.config ? this.#render(step.config, comment!, brand, conn!) : undefined;
        next = { step, kind, requestKey, text };
        break;
      }
      const r = ld.requested!.result;
      if (r.status === 'refused') {
        await settle(step, stepOutcomeFor({ kind: 'refused', code: r.code }));
        continue;
      }
      const linked = await runs.linkAction(
        tx,
        scope,
        step.id,
        r.action.id,
        ld.requested!.requestKey,
      );
      if (linked === 'owned_by_other_step') {
        await settle(step, { status: 'skipped', reason: 'duplicate' });
        continue;
      }
      views.set(r.action.id, r.action);
      await settleAction(step, r.action.id);
    }

    const completed = !next && open === 0;
    if (completed) await runs.markRunCompleted(tx, scope, run.id);
    return { events, waiting, completed, final: run.steps.length - open, run, next };
  }

  async #flag(
    tx: pg.PoolClient,
    scope: ConnectionScope,
    run: RunRow,
    step: StepRow,
    settle: (s: StepRow, o: StepOutcome, x?: { reviewItemId?: string }) => Promise<void>,
  ): Promise<void> {
    await tx.query('SAVEPOINT flag_review');
    let item: { id: string; created: boolean };
    try {
      item = await this.d.review.open(tx, scope, {
        commentId: run.commentId,
        source: 'action_step',
        ruleId: run.ruleId,
        evaluationId: run.evaluationId,
      });
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT flag_review');
      await tx.query('RELEASE SAVEPOINT flag_review');
      this.d.log.warn('action_step.flag_failed', {
        runId: run.id,
        stepId: step.id,
        error: errorName(err),
      });
      await settle(step, { status: 'failed', reason: 'internal_error' });
      return;
    }
    await tx.query('RELEASE SAVEPOINT flag_review');
    if (item.created)
      await settle(step, { status: 'succeeded', reason: null }, { reviewItemId: item.id });
    else await settle(step, { status: 'skipped', reason: 'already_flagged' });
  }

  /** Idempotent on the request key, so it runs outside the run lock. */
  #request(scope: ConnectionScope, run: RunRow, n: PendingRequest): Promise<Requested['result']> {
    return this.d.actions.request({
      scope,
      commentId: run.commentId,
      kind: n.kind,
      actor: { type: 'rule', ruleId: run.ruleId },
      requestKey: n.requestKey,
      ...(n.text !== undefined && { text: n.text }),
    });
  }

  async #notify(e: Settled): Promise<void> {
    try {
      await this.d.observer?.onStepSettled(e);
    } catch (err) {
      this.d.log.error('action_step.observer_failed', {
        runId: e.runId,
        stepId: e.stepId,
        error: errorName(err),
      });
    }
  }

  /**
   * An action can finish between `request` and the commit that links it; its outcome
   * wake-up then finds no step. Re-read and wake the run for any that already finished.
   */
  async #wakeIfAlreadyFinal(
    scope: ConnectionScope,
    done: { waiting: { step: StepRow; actionId: string }[]; run: RunRow; final: number },
  ): Promise<void> {
    if (done.waiting.length === 0) return;
    const views = await this.d.actions.list(scope, done.run.commentId);
    const comment = await this.d.comments.load(scope, done.run.commentId);
    if (!comment) return;
    for (const { step, actionId } of done.waiting) {
      const v = views.find((x) => x.id === actionId);
      if (v && v.status !== 'pending')
        await wake(this.d.producer, scope, comment.platform, {
          runId: done.run.id,
          settled: done.final + 1,
          cause: `${step.id}:${v.status}`,
        });
    }
  }
}

export function actionRunAdvanceJob(r: ActionRunner): JobDefinition<ActionRunAdvancePayload> {
  return {
    ...ACTION_RUN_ADVANCE_JOB,
    handle: async (ctx, p) => r.advance(ctx.scope, p.runId),
  };
}

/** Maps an action outcome to its step and wakes the run. Outcomes of actions without a step are ignored. */
export class ActionStepOutcomeObserver implements ActionOutcomeObserver {
  constructor(private readonly d: { runs: PgActionRunStore; producer: Producer; log: Logger }) {}

  async onActionOutcome(e: Parameters<ActionOutcomeObserver['onActionOutcome']>[0]): Promise<void> {
    const step = await this.d.runs.findStepByAction(e.scope, e.actionId);
    if (!step) return;
    if (e.status === 'deferred') {
      const waiting = stepOutcomeFor({ kind: 'action', status: 'deferred', code: e.code });
      await this.d.runs.markStepWaiting(e.scope, step.stepId, waiting.reason ?? 'rate_limited');
    }
    const settled = await this.d.runs.countSettledSteps(e.scope, step.runId);
    this.d.log.debug('action_step.wake', {
      runId: step.runId,
      stepId: step.stepId,
      status: e.status,
    });
    await wake(this.d.producer, { ...e.scope, connectionId: step.connectionId }, e.platform, {
      runId: step.runId,
      settled: settled + 1,
      cause: `${step.stepId}:${e.status}`,
    });
  }
}
