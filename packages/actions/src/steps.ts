import type { ActionKind } from '@feedbouncer/comments';
import { z } from 'zod';
import { validateTemplate } from './templates.js';

/** Execution order: review first, harmless replies next, destructive steps last. */
export const STEP_TYPES = [
  'flag_for_review',
  'private_reply',
  'auto_reply',
  'hide',
  'ban',
  'delete',
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const STEP_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'skipped',
  'not_applicable',
  'not_supported',
  'simulated',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export type ActionStep =
  | { type: 'hide' }
  | { type: 'flag_for_review' }
  | { type: 'delete'; confirmIrreversible: true }
  | { type: 'ban'; confirmHardToReverse: true }
  | { type: 'auto_reply'; template: string }
  | { type: 'private_reply'; template: string };

/** Moderation action recorded for each step that acts on the platform. */
export const MODERATION_KIND: Record<Exclude<StepType, 'flag_for_review'>, ActionKind> = {
  hide: 'hide',
  delete: 'delete',
  ban: 'ban_author',
  auto_reply: 'public_reply',
  private_reply: 'private_reply',
};

export const STEP_META: Record<
  StepType,
  {
    reversibility: 'reversible' | 'irreversible' | 'hard_to_reverse' | 'partly_reversible';
    undo: ActionKind | 'dismiss_review' | null;
    destructive: boolean;
  }
> = {
  flag_for_review: { reversibility: 'reversible', undo: 'dismiss_review', destructive: false },
  private_reply: { reversibility: 'irreversible', undo: null, destructive: false },
  auto_reply: { reversibility: 'partly_reversible', undo: null, destructive: false },
  hide: { reversibility: 'reversible', undo: 'unhide', destructive: false },
  ban: { reversibility: 'hard_to_reverse', undo: 'unban_author', destructive: true },
  delete: { reversibility: 'irreversible', undo: null, destructive: true },
};

/** Step pairs that cannot be combined, with the reason code reported to the user. */
export const CONFLICTS: readonly (readonly [StepType, StepType, string])[] = [
  ['auto_reply', 'hide', 'reply_to_hidden_comment'],
  ['auto_reply', 'delete', 'reply_to_deleted_comment'],
  ['private_reply', 'ban', 'message_to_banned_author'],
  ['hide', 'delete', 'hide_redundant_with_delete'],
];

/** The steps in execution order. */
export const sortSteps = (steps: readonly ActionStep[]): ActionStep[] =>
  [...steps].sort((a, b) => STEP_TYPES.indexOf(a.type) - STEP_TYPES.indexOf(b.type));

const templateSchema = z
  .string()
  .superRefine((t, ctx) => {
    const result = validateTemplate(t);
    if (!result.ok) ctx.addIssue({ code: 'custom', message: result.code });
  })
  .transform((t) => t.trim());

const stepSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('flag_for_review') }),
  z.strictObject({ type: z.literal('hide') }),
  z.strictObject({ type: z.literal('delete'), confirmIrreversible: z.literal(true) }),
  z.strictObject({ type: z.literal('ban'), confirmHardToReverse: z.literal(true) }),
  z.strictObject({ type: z.literal('auto_reply'), template: templateSchema }),
  z.strictObject({ type: z.literal('private_reply'), template: templateSchema }),
]);

export const actionStepsSchema: z.ZodType<ActionStep[], unknown> = z
  .array(stepSchema)
  .max(STEP_TYPES.length)
  .superRefine((steps, ctx) => {
    const seen = new Set<StepType>();
    steps.forEach((step, i) => {
      if (seen.has(step.type)) {
        ctx.addIssue({ code: 'custom', path: [i], message: 'duplicate_step' });
      }
      seen.add(step.type);
    });
    for (const [a, b, code] of CONFLICTS) {
      if (!seen.has(a) || !seen.has(b)) continue;
      const i = steps.findIndex((s) => s.type === b);
      ctx.addIssue({ code: 'custom', path: [i], message: code });
    }
  })
  .transform(sortSteps);

export function deriveOutcome(
  steps: readonly ActionStep[],
): 'approve' | 'flag' | 'hide' | 'remove' {
  const has = (t: StepType) => steps.some((s) => s.type === t);
  if (has('delete')) return 'remove';
  if (has('hide')) return 'hide';
  if (has('flag_for_review')) return 'flag';
  return 'approve';
}

/**
 * Every reason code this package maps or emits itself; web copy tests cover each one.
 * Unknown reasons are passed through (safeOutcomeCode), so consumers must tolerate them.
 */
export const REASON_CODES: readonly string[] = [
  // outcome mapping
  'comment_gone',
  'already_hidden',
  'already_visible',
  'author_unavailable',
  'author_is_page',
  'private_reply_window_closed',
  'private_reply_nested_comment',
  'reply_to_hidden_comment',
  'own_account_comment',
  'own_comment_always_visible',
  'private_reply_already_sent',
  'ban_limit_reached',
  'reblock_too_soon',
  'author_not_bannable',
  'unsupported',
  'missing_permission',
  'author_gone',
  'text_too_long',
  'reply_too_long',
  'rate_limited',
  'awaiting_reconnect',
  'hide_nested_reply_unsupported',
  'reply_quota_exhausted',
  // settling and fallbacks
  'rate_limit_exhausted',
  'retries_exhausted',
  'connection_needs_reconnect',
  'connection_inactive',
  'request_key_conflict',
  'failed',
  // prechecks and runner
  'moderator_override',
  'reply_thread_limit',
  'duplicate',
  'already_flagged',
  'would_run',
  'internal_error',
  'review_mode_active',
  'already_banned',
  'approver_removed',
  // step conflicts and schema
  'duplicate_step',
  'reply_to_deleted_comment',
  'message_to_banned_author',
  'hide_redundant_with_delete',
  // brand checks
  'not_supported_anywhere',
  'not_supported_on_platform',
  'template_too_long',
];
