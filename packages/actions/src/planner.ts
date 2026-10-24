// Read-only judgement of what a rule's steps would do to a comment: why a step cannot run,
// what the platform would answer and what a reply would say. Nothing is stored or sent.
import type { Clock, Platform } from '@feedbouncer/connectors';
import {
  eligibilityComment,
  evaluateEligibility,
  type BrandScope,
  type CommentRow,
  type ModerationActionView,
  type ModerationActions,
  type PgCommentStore,
} from '@feedbouncer/comments';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { PgActionRunStore, Queryable } from './runs.js';
import { MODERATION_KIND, sortSteps, type ActionStep, type StepType } from './steps.js';
import {
  stepOutcomeFor,
  stepSupport,
  type BrandConnectionInfo,
  type StepOutcome,
} from './support.js';
import { renderTemplate } from './templates.js';

export interface SimulatedStep {
  type: StepType;
  status: StepOutcome['status'];
  reason: string | null;
  previewText: string | null;
}

const PLATFORM_NAME: Partial<Record<Platform, string>> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
};
const WOULD_RUN: StepOutcome = { status: 'succeeded', reason: 'would_run' };

export class StepPlanner {
  constructor(
    private readonly d: {
      runs: Pick<PgActionRunStore, 'hasUserReversal' | 'hasAutomatedThreadReply' | 'hasActiveBan'>;
      comments: Pick<PgCommentStore, 'load'>;
      actions: Pick<ModerationActions, 'list'>;
      connection: (scope: ConnectionScope) => Promise<BrandConnectionInfo | null>;
      brandName: (scope: BrandScope) => Promise<string>;
      clock: Clock;
    },
  ) {}

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
        'template' in step && comment && conn ? this.render(step, comment, brand, conn) : null;
      const o = await this.precheck(scope, step.type, comment, conn, views);
      const { status, reason } = o ?? this.#predict(step, comment!, conn!);
      out.push({ type: step.type, status, reason, previewText });
    }
    return out;
  }

  render(
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

  /**
   * Reasons a step cannot run at all, checked in a fixed order; null when it can. An approved
   * step was chosen by a moderator: earlier reversals and thread replies do not stop it, only
   * an author who is already banned does.
   */
  async precheck(
    scope: ConnectionScope,
    type: StepType,
    comment: CommentRow | null,
    conn: BrandConnectionInfo | null,
    views: readonly ModerationActionView[],
    db?: Queryable,
    o: { approved?: boolean; suggestionId?: string } = {},
  ): Promise<StepOutcome | null> {
    if (!comment) return { status: 'not_applicable', reason: 'comment_gone' };
    if (comment.isOwnAccount) return { status: 'skipped', reason: 'own_account_comment' };
    if (!conn) return { status: 'failed', reason: 'connection_inactive' };
    const support = stepSupport(type, conn);
    if (!support.supported) return { status: 'not_supported', reason: 'unsupported' };
    if (support.missingScopes.length > 0)
      return {
        status: 'failed',
        reason: 'missing_permission',
        missingScopes: support.missingScopes,
      };
    if (o.approved) {
      const ownBanKey = o.suggestionId ? `suggestion:${o.suggestionId}:ban_author` : null;
      if (type === 'ban' && (await this.d.runs.hasActiveBan(scope, comment.id, db, ownBanKey)))
        return { status: 'skipped', reason: 'already_banned' };
    } else if (type === 'hide' || type === 'ban') {
      const kind = type === 'hide' ? 'hide' : 'ban_author';
      if (await this.d.runs.hasUserReversal(scope, comment.id, kind, db))
        return { status: 'skipped', reason: 'moderator_override' };
    }
    if (
      !o.approved &&
      type === 'auto_reply' &&
      (await this.#threadLimited(scope, comment.id, views, db))
    )
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
}
