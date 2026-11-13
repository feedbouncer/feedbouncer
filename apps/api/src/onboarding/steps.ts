export const STEPS = ['connect', 'defaults', 'review_mode', 'report'] as const;
export type Step = (typeof STEPS)[number];
export type StepStatuses = Record<Step, 'pending' | 'done'>;

export function isStep(v: unknown): v is Step {
  return typeof v === 'string' && (STEPS as readonly string[]).includes(v);
}

export function resumeStep(s: StepStatuses): Step | null {
  return STEPS.find((step) => s[step] === 'pending') ?? null;
}

export function isReachable(s: StepStatuses, step: Step): boolean {
  return STEPS.slice(0, STEPS.indexOf(step)).every((earlier) => s[earlier] === 'done');
}

export function markDone(s: StepStatuses, step: Step): { next: StepStatuses; changed: boolean } {
  if (s[step] === 'done') return { next: s, changed: false };
  return { next: { ...s, [step]: 'done' }, changed: true };
}

export function isComplete(s: StepStatuses): boolean {
  return STEPS.every((step) => s[step] === 'done');
}

export function resetAll(): StepStatuses {
  return { connect: 'pending', defaults: 'pending', review_mode: 'pending', report: 'pending' };
}
