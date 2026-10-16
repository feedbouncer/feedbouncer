import { CONFLICTS, STEP_TYPES, sortSteps, type ActionStep, type StepType } from './steps.js';

export const GATED_STEP_TYPES = ['private_reply', 'auto_reply', 'hide', 'ban', 'delete'] as const;
export type GatedStep = Exclude<ActionStep, { type: 'flag_for_review' }>;

export const SUGGESTION_STATUSES = [
  'pending',
  'approved',
  'dismissed',
  'expired',
  'not_applicable',
  'withdrawn',
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const SUGGESTION_REASONS = [
  'comment_gone',
  'comment_edited',
  'rule_changed',
  'review_mode_ended',
  'grace_period_ended',
] as const;

const isGated = (s: ActionStep): s is GatedStep => s.type !== 'flag_for_review';

export function splitGated(steps: readonly ActionStep[]): {
  flag: ActionStep[];
  gated: GatedStep[];
} {
  return {
    flag: steps.filter((s) => !isGated(s)),
    gated: steps.filter(isGated),
  };
}

/** What a classifier or policy verdict would do. */
export function stepsForOutcome(outcome: 'hide' | 'remove'): GatedStep[] {
  return outcome === 'hide' ? [{ type: 'hide' }] : [{ type: 'delete', confirmIrreversible: true }];
}

export interface PlanSource {
  createdAt: Date;
  steps: readonly GatedStep[];
}

// The step that explains a conflict first is the one furthest along the execution order.
const CONFLICTS_BY_CAUSE = [...CONFLICTS].sort(
  (x, y) => STEP_TYPES.indexOf(y[1]) - STEP_TYPES.indexOf(x[1]),
);

/** One step per type (earliest source wins its config), in execution order, minus conflicting steps. */
export function mergePlan(sources: readonly PlanSource[]): {
  steps: GatedStep[];
  dropped: { type: StepType; reason: string }[];
} {
  const byType = new Map<StepType, GatedStep>();
  const ordered = [...sources].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const source of ordered) {
    for (const step of source.steps) if (!byType.has(step.type)) byType.set(step.type, step);
  }
  const dropped = new Map<StepType, string>();
  for (const [loser, winner, reason] of CONFLICTS_BY_CAUSE) {
    if (byType.has(loser) && byType.has(winner) && !dropped.has(loser)) dropped.set(loser, reason);
  }
  return {
    steps: sortSteps([...byType.values()].filter((s) => !dropped.has(s.type))) as GatedStep[],
    dropped: [...dropped].map(([type, reason]) => ({ type, reason })),
  };
}

export const needsConfirmation = (steps: readonly GatedStep[]): boolean =>
  steps.some((s) => s.type === 'delete' || s.type === 'ban');
