// User-driven follow-ups to automated steps: undoing a step from the log and resolving a
// review queue item. Both go through ModerationActions.request with the user as actor, so the
// action is idempotent on its request key; scoping is by organization + brand on every query.
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import {
  isClientRequestKey,
  type ActionKind,
  type BrandScope,
  type ModerationActions,
  type PgCommentStore,
  type RequestActionResult,
} from '@feedbouncer/comments';
import { UUID } from '@feedbouncer/service-runtime';
import type { PgReviewQueue } from './review.js';
import type { PgActionRunStore } from './runs.js';

type ConnectionRefusal = 'connection_needs_reconnect' | 'connection_inactive';

export type UndoResult =
  | { status: 'accepted' | 'done'; undoActionId: string | null }
  | {
      status: 'refused';
      code:
        | 'not_found'
        | 'undo_not_available'
        | 'already_undone'
        | 'unsupported'
        | ConnectionRefusal;
    };

export type Resolution = 'approve' | 'hide' | 'delete' | 'ban';

export type ResolveResult =
  | { status: 'resolved'; actionId: string | null }
  | {
      status: 'refused';
      code:
        | 'not_found'
        | 'review_item_resolved'
        | 'confirmation_required'
        | 'unsupported'
        | 'request_key_conflict'
        | ConnectionRefusal;
    };

const UNDO_KIND = { hide: 'unhide', ban: 'unban_author' } as const;

const RESOLUTION = {
  approve: { outcome: 'approved', kind: null, confirm: false },
  hide: { outcome: 'hidden', kind: 'hide', confirm: false },
  delete: { outcome: 'deleted', kind: 'delete', confirm: true },
  ban: { outcome: 'banned', kind: 'ban_author', confirm: true },
} as const satisfies Record<
  Resolution,
  { outcome: string; kind: ActionKind | null; confirm: boolean }
>;

async function audit(
  tx: pg.ClientBase,
  scope: BrandScope,
  userId: string,
  e: { action: string; subjectType: string; subjectId: string; details: object },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_event (organization_id, brand_id, actor_type, actor_user_id, action,
                              subject_type, subject_id, details)
     VALUES ($1, $2, 'user', $3, $4, $5, $6, $7::jsonb)`,
    [
      scope.organizationId,
      scope.brandId,
      userId,
      e.action,
      e.subjectType,
      e.subjectId,
      JSON.stringify(e.details),
    ],
  );
}

type Refusal = Extract<RequestActionResult, { status: 'refused' }>['code'];

const FORWARDED: ReadonlySet<Refusal> = new Set([
  'not_found',
  'connection_needs_reconnect',
  'connection_inactive',
]);

/** The refusal codes both services pass on; everything else means the action cannot be taken. */
const forward = (code: Refusal) =>
  FORWARDED.has(code) ? (code as 'not_found' | ConnectionRefusal) : null;

export async function undoStep(
  d: {
    pool: pg.Pool;
    runs: PgActionRunStore;
    review: PgReviewQueue;
    actions: Pick<ModerationActions, 'request'>;
  },
  scope: BrandScope,
  stepId: string,
  userId: string,
): Promise<UndoResult> {
  const refused = (code: Extract<UndoResult, { status: 'refused' }>['code']): UndoResult => ({
    status: 'refused',
    code,
  });
  if (!UUID.test(userId)) throw new TypeError('Invalid undo: userId');
  if (!UUID.test(stepId)) return refused('not_found');
  const step = await d.runs.loadStep(scope, stepId);
  if (!step) return refused('not_found');
  if (step.undoneAt) return refused('already_undone');
  if (
    step.status !== 'succeeded' ||
    step.dryRun ||
    (step.type !== 'hide' && step.type !== 'ban' && step.type !== 'flag_for_review')
  )
    return refused('undo_not_available');

  let undoActionId: string | null = null;
  let status: 'accepted' | 'done' = 'done';
  if (step.type !== 'flag_for_review') {
    if (!step.moderationActionId) return refused('undo_not_available');
    const r = await d.actions.request({
      scope,
      commentId: step.commentId,
      kind: UNDO_KIND[step.type],
      actor: { type: 'user', userId },
      requestKey: `undo:${stepId}`,
      reverses: step.moderationActionId,
    });
    if (r.status === 'refused') return refused(forward(r.code) ?? 'unsupported');
    if (r.action.status === 'not_eligible' || r.action.status === 'failed')
      return refused('undo_not_available');
    undoActionId = r.action.id;
    status = r.status === 'accepted' ? 'accepted' : 'done';
  }

  const marked = await withTransaction(d.pool, async (tx) => {
    if (!(await d.runs.markUndone(tx, scope, stepId, userId, undoActionId))) return false;
    if (step.type === 'flag_for_review' && step.reviewItemId)
      await d.review.resolve(tx, scope, step.reviewItemId, {
        resolution: 'dismissed',
        userId,
        actionId: null,
      });
    await audit(tx, scope, userId, {
      action: 'action_step.undone',
      subjectType: 'action_run_step',
      subjectId: stepId,
      details: { stepId, type: step.type, undoActionId },
    });
    return true;
  });
  return marked ? { status, undoActionId } : refused('already_undone');
}

export async function resolveReviewItem(
  d: {
    pool: pg.Pool;
    review: PgReviewQueue;
    comments: PgCommentStore;
    actions: Pick<ModerationActions, 'request'>;
  },
  scope: BrandScope,
  itemId: string,
  i: { resolution: Resolution; userId: string; requestKey: string; confirm?: boolean },
): Promise<ResolveResult> {
  const refused = (code: Extract<ResolveResult, { status: 'refused' }>['code']): ResolveResult => ({
    status: 'refused',
    code,
  });
  const bad = (f: string): never => {
    throw new TypeError(`Invalid review resolution: ${f}`);
  };
  if (!Object.hasOwn(RESOLUTION, i.resolution)) bad('resolution');
  if (!UUID.test(i.userId)) bad('userId');
  if (!isClientRequestKey(i.requestKey)) bad('requestKey');
  if (!UUID.test(itemId)) return refused('not_found');

  const item = await d.review.load(scope, itemId);
  if (!item) return refused('not_found');
  if (item.status === 'resolved') return refused('review_item_resolved');
  const plan = RESOLUTION[i.resolution];
  if (plan.confirm && i.confirm !== true) return refused('confirmation_required');

  const actor = { type: 'user', userId: i.userId } as const;
  let request: { kind: ActionKind; requestKey: string } | null = plan.kind
    ? { kind: plan.kind, requestKey: i.requestKey }
    : null;
  if (i.resolution === 'approve' && (await autoHidden(d, scope, item.commentId)))
    request = { kind: 'unhide', requestKey: `review:${itemId}:unhide` };

  let actionId: string | null = null;
  if (request) {
    const r = await d.actions.request({ scope, commentId: item.commentId, actor, ...request });
    if (r.status === 'refused') {
      const code = forward(r.code) ?? (r.code === 'request_key_conflict' ? r.code : 'unsupported');
      return refused(code);
    }
    if (r.action.status === 'not_eligible' || r.action.status === 'failed')
      return refused('unsupported');
    actionId = r.action.id;
  }

  const done = await withTransaction(d.pool, async (tx) => {
    const ok = await d.review.resolve(tx, scope, itemId, {
      resolution: plan.outcome,
      userId: i.userId,
      actionId,
    });
    if (ok)
      await audit(tx, scope, i.userId, {
        action: 'review_item.resolved',
        subjectType: 'review_item',
        subjectId: itemId,
        details: { itemId, resolution: plan.outcome, actionId },
      });
    return ok;
  });
  return done ? { status: 'resolved', actionId } : refused('review_item_resolved');
}

/** True when the comment is hidden and the latest applied hide was not made by a person. */
async function autoHidden(
  d: { pool: pg.Pool; comments: PgCommentStore },
  scope: BrandScope,
  commentId: string,
): Promise<boolean> {
  const comment = await d.comments.load(scope, commentId);
  if (comment?.platformState !== 'hidden') return false;
  const r = await d.pool.query<{ actor_type: string }>(
    `SELECT actor_type FROM moderation_action
      WHERE organization_id = $1 AND brand_id = $2 AND comment_id = $3
        AND kind = 'hide' AND status = 'applied'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [scope.organizationId, scope.brandId, commentId],
  );
  return r.rows[0] !== undefined && r.rows[0].actor_type !== 'user';
}
