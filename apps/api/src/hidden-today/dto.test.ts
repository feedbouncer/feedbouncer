import { describe, expect, it } from 'vitest';
import type { HiddenItem } from '@feedbouncer/actions';
import { toHiddenItemDto, toNextDto } from './dto.js';

const at = new Date('2026-10-16T10:00:00.000Z');
const item = {
  hideActionId: 'h1',
  hiddenAt: at,
  ruleStepId: 'step-1',
  lastAttempt: {
    actionId: 'u1',
    status: 'pending',
    outcomeCode: null,
    createdAt: at,
    completedAt: null,
  },
  history: [
    {
      kind: 'hide',
      actorType: 'rule',
      actorName: 'Spam rule',
      status: 'applied',
      outcomeCode: null,
      at,
    },
    {
      kind: 'unhide',
      actorType: 'user',
      actorName: 'Dana',
      status: 'pending',
      outcomeCode: null,
      at,
    },
  ],
} as unknown as HiddenItem;

describe('toHiddenItemDto', () => {
  const dto = toHiddenItemDto(item);

  it('turns every date into an ISO string', () => {
    expect(dto.hiddenAt).toBe('2026-10-16T10:00:00.000Z');
    expect(dto.lastAttempt).toMatchObject({
      createdAt: '2026-10-16T10:00:00.000Z',
      completedAt: null,
    });
    expect(dto.history.map((h) => h.at)).toEqual([
      '2026-10-16T10:00:00.000Z',
      '2026-10-16T10:00:00.000Z',
    ]);
  });
  it('names only people in the history and keeps run step ids server-side', () => {
    expect(dto.history.map((h) => h.actorName)).toEqual([null, 'Dana']);
    expect(dto).not.toHaveProperty('ruleStepId');
  });
});

describe('toNextDto', () => {
  it('is the query pair for the next request, or null', () => {
    expect(toNextDto({ hiddenAt: at, hideActionId: 'h1' })).toEqual({
      before: '2026-10-16T10:00:00.000Z',
      beforeId: 'h1',
    });
    expect(toNextDto(null)).toBeNull();
  });
});
