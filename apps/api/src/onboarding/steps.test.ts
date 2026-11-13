import { describe, expect, it } from 'vitest';
import {
  isComplete,
  isReachable,
  isStep,
  markDone,
  resetAll,
  resumeStep,
  type StepStatuses,
} from './steps.js';

const allPending = resetAll();
const allDone: StepStatuses = {
  connect: 'done',
  defaults: 'done',
  review_mode: 'done',
  report: 'done',
};

describe('onboarding steps', () => {
  it('only the first step is reachable from a fresh state', () => {
    expect(isReachable(allPending, 'connect')).toBe(true);
    expect(isReachable(allPending, 'defaults')).toBe(false);
  });

  it('a step is unreachable while an earlier step is pending', () => {
    const s: StepStatuses = {
      connect: 'done',
      defaults: 'pending',
      review_mode: 'pending',
      report: 'pending',
    };
    expect(isReachable(s, 'review_mode')).toBe(false);
    expect(isReachable(s, 'defaults')).toBe(true);
  });

  it('resumes at the first pending step', () => {
    expect(
      resumeStep({
        connect: 'done',
        defaults: 'done',
        review_mode: 'pending',
        report: 'pending',
      }),
    ).toBe('review_mode');
  });

  it('has no resume step once all are done', () => {
    expect(resumeStep(allDone)).toBeNull();
  });

  it('reports changed=false when marking an already-done step', () => {
    expect(markDone(allDone, 'defaults').changed).toBe(false);
  });

  it('marks a pending step done and reports changed=true', () => {
    const { next, changed } = markDone(allPending, 'connect');
    expect(changed).toBe(true);
    expect(next.connect).toBe('done');
    expect(allPending.connect).toBe('pending');
  });

  it('is complete only when every step is done', () => {
    expect(isComplete(allDone)).toBe(true);
    expect(isComplete(allPending)).toBe(false);
  });

  it('accepts only known step names', () => {
    expect(isStep('../x')).toBe(false);
    expect(isStep('report')).toBe(true);
  });
});
