import { describe, expect, it } from 'vitest';
import {
  actionStepsSchema,
  deriveOutcome,
  MODERATION_KIND,
  STEP_META,
  type ActionStep,
} from './steps.js';

const p = (x: unknown) => actionStepsSchema.safeParse(x);

describe('action steps', () => {
  it('orders steps deterministically regardless of input order', () => {
    const r = p([
      { type: 'delete', confirmIrreversible: true },
      { type: 'flag_for_review' },
      { type: 'private_reply', template: 'Hi' },
    ]);
    expect(r.success && r.data.map((s) => s.type)).toEqual([
      'flag_for_review',
      'private_reply',
      'delete',
    ]);
  });

  it('requires explicit opt-in for delete and ban', () => {
    expect(p([{ type: 'delete' }]).success).toBe(false);
    expect(p([{ type: 'delete', confirmIrreversible: false }]).success).toBe(false);
    expect(p([{ type: 'ban' }]).success).toBe(false);
    expect(p([{ type: 'ban', confirmHardToReverse: true }]).success).toBe(true);
  });

  it.each([
    [[{ type: 'auto_reply', template: 'x' }, { type: 'hide' }], 'reply_to_hidden_comment'],
    [
      [
        { type: 'auto_reply', template: 'x' },
        { type: 'delete', confirmIrreversible: true },
      ],
      'reply_to_deleted_comment',
    ],
    [
      [
        { type: 'private_reply', template: 'x' },
        { type: 'ban', confirmHardToReverse: true },
      ],
      'message_to_banned_author',
    ],
    [
      [{ type: 'hide' }, { type: 'delete', confirmIrreversible: true }],
      'hide_redundant_with_delete',
    ],
    [[{ type: 'hide' }, { type: 'hide' }], 'duplicate_step'],
  ])('rejects conflicting combination %j', (steps, code) => {
    const r = p(steps);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(code);
  });

  it('rejects unknown types and extra keys', () => {
    expect(p([{ type: 'mute' }]).success).toBe(false);
    expect(p([{ type: 'hide', x: 1 }]).success).toBe(false);
  });

  it('allows the empty list', () => expect(p([]).success).toBe(true));

  it.each([
    [[], 'approve'],
    [[{ type: 'auto_reply', template: 'x' }], 'approve'],
    [[{ type: 'flag_for_review' }, { type: 'ban', confirmHardToReverse: true }], 'flag'],
    [[{ type: 'hide' }, { type: 'flag_for_review' }], 'hide'],
    [[{ type: 'delete', confirmIrreversible: true }], 'remove'],
  ])('deriveOutcome(%j) = %s', (steps, out) =>
    expect(deriveOutcome(steps as ActionStep[])).toBe(out),
  );
});

describe('reply templates in steps', () => {
  it('rejects reply step with unknown variable', () => {
    for (const type of ['auto_reply', 'private_reply']) {
      const r = p([{ type, template: 'Hi {{nme}}' }]);
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain('unknown_variable');
    }
  });

  it('rejects empty reply templates', () => {
    expect(p([{ type: 'auto_reply', template: '  ' }]).success).toBe(false);
  });
});

describe('step metadata', () => {
  it.each([
    ['flag_for_review', 'reversible', 'dismiss_review'],
    ['private_reply', 'irreversible', null],
    ['auto_reply', 'partly_reversible', null],
    ['hide', 'reversible', 'unhide'],
    ['ban', 'hard_to_reverse', 'unban_author'],
    ['delete', 'irreversible', null],
  ] as const)('STEP_META.%s is %s with undo %s', (type, reversibility, undo) => {
    expect(STEP_META[type]).toMatchObject({ reversibility, undo });
  });

  it('maps step types to moderation kinds', () => {
    expect(MODERATION_KIND).toEqual({
      hide: 'hide',
      delete: 'delete',
      ban: 'ban_author',
      auto_reply: 'public_reply',
      private_reply: 'private_reply',
    });
  });
});
