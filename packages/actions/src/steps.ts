import type { ActionKind } from '@feedbouncer/comments';
import { z } from 'zod';

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
  auto_reply: { reversibility: 'partly_reversible', undo: 'delete', destructive: false },
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

const stepSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('flag_for_review') }),
  z.strictObject({ type: z.literal('hide') }),
  z.strictObject({ type: z.literal('delete'), confirmIrreversible: z.literal(true) }),
  z.strictObject({ type: z.literal('ban'), confirmHardToReverse: z.literal(true) }),
  z.strictObject({ type: z.literal('auto_reply'), template: z.string() }),
  z.strictObject({ type: z.literal('private_reply'), template: z.string() }),
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
  .transform((steps) =>
    [...steps].sort((x, y) => STEP_TYPES.indexOf(x.type) - STEP_TYPES.indexOf(y.type)),
  );

export function deriveOutcome(
  steps: readonly ActionStep[],
): 'approve' | 'flag' | 'hide' | 'remove' {
  const has = (t: StepType) => steps.some((s) => s.type === t);
  if (has('delete')) return 'remove';
  if (has('hide')) return 'hide';
  if (has('flag_for_review')) return 'flag';
  return 'approve';
}
