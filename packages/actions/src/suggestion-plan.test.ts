import { describe, expect, it } from 'vitest';
import type { ActionStep } from './steps.js';
import {
  mergePlan,
  needsConfirmation,
  splitGated,
  stepsForOutcome,
  type GatedStep,
} from './suggestion-plan.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 16, 0, 0, s));

describe('suggestion plan', () => {
  it('splitGated keeps flag apart', () => {
    const steps: ActionStep[] = [{ type: 'flag_for_review' }, { type: 'hide' }];
    expect(splitGated(steps)).toEqual({
      flag: [{ type: 'flag_for_review' }],
      gated: [{ type: 'hide' }],
    });
  });

  it('mergePlan unions by type, first source wins the template', () => {
    const plan = mergePlan([
      { createdAt: at(2), steps: [{ type: 'private_reply', template: 'second' }] },
      {
        createdAt: at(1),
        steps: [{ type: 'private_reply', template: 'first' }, { type: 'hide' }],
      },
    ]);
    expect(plan).toEqual({
      steps: [{ type: 'private_reply', template: 'first' }, { type: 'hide' }],
      dropped: [],
    });
  });

  it('delete drops hide and auto_reply with reasons', () => {
    const plan = mergePlan([
      {
        createdAt: at(1),
        steps: [
          { type: 'hide' },
          { type: 'auto_reply', template: 'hi' },
          { type: 'delete', confirmIrreversible: true },
        ],
      },
    ]);
    expect(plan.steps).toEqual([{ type: 'delete', confirmIrreversible: true }]);
    expect(plan.dropped).toEqual([
      { type: 'auto_reply', reason: 'reply_to_deleted_comment' },
      { type: 'hide', reason: 'hide_redundant_with_delete' },
    ]);
  });

  it('ban drops private_reply', () => {
    const plan = mergePlan([
      {
        createdAt: at(1),
        steps: [
          { type: 'private_reply', template: 'hi' },
          { type: 'ban', confirmHardToReverse: true },
        ],
      },
    ]);
    expect(plan.steps).toEqual([{ type: 'ban', confirmHardToReverse: true }]);
    expect(plan.dropped).toEqual([{ type: 'private_reply', reason: 'message_to_banned_author' }]);
  });

  it('classifier remove maps to delete with confirmIrreversible', () => {
    expect(stepsForOutcome('remove')).toEqual([{ type: 'delete', confirmIrreversible: true }]);
    expect(stepsForOutcome('hide')).toEqual([{ type: 'hide' }]);
  });

  it('needsConfirmation true for delete or ban only', () => {
    const t = (...steps: GatedStep[]) => needsConfirmation(steps);
    expect(t({ type: 'delete', confirmIrreversible: true })).toBe(true);
    expect(t({ type: 'ban', confirmHardToReverse: true })).toBe(true);
    expect(t({ type: 'hide' }, { type: 'auto_reply', template: 'x' })).toBe(false);
  });
});
