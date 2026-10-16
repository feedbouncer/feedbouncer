import { describe, expect, it } from 'vitest';
import type { ActionStatus } from '@feedbouncer/comments';
import type { PlatformState } from '@feedbouncer/connectors';
import {
  HIDDEN_ROW_STATES,
  canUnhide,
  hiddenRowState,
  type UnhideAttempt,
} from './hidden-today.js';

const attempt = (status: ActionStatus, outcomeCode: string | null = null): UnhideAttempt => ({
  actionId: 'a',
  status,
  outcomeCode,
  createdAt: new Date(0),
  completedAt: status === 'pending' ? null : new Date(0),
});
const state = (commentState: PlatformState, lastAttempt: UnhideAttempt | null) =>
  hiddenRowState({ commentState, lastAttempt });

describe('hiddenRowState', () => {
  it('is unavailable when the comment is deleted', () => {
    expect(state('deleted', null)).toBe('unavailable');
  });
  it('is unavailable after a comment_gone attempt', () => {
    expect(state('hidden', attempt('noop', 'comment_gone'))).toBe('unavailable');
  });
  it('deleted wins over a pending attempt', () => {
    expect(state('deleted', attempt('pending'))).toBe('unavailable');
  });
  it('is pending while the unhide is pending', () => {
    expect(state('hidden', attempt('pending'))).toBe('pending');
  });
  it('is restored after an applied unhide', () => {
    expect(state('visible', attempt('applied'))).toBe('restored');
  });
  it('is already_visible after a noop already_visible', () => {
    expect(state('hidden', attempt('noop', 'already_visible'))).toBe('already_visible');
  });
  it('is failed after a failed or not_eligible attempt', () => {
    expect(state('hidden', attempt('failed', 'permission_denied'))).toBe('failed');
    expect(state('hidden', attempt('not_eligible', 'connection_inactive'))).toBe('failed');
  });
  it('is already_visible when nothing was attempted and the comment is visible', () => {
    expect(state('visible', null)).toBe('already_visible');
  });
  it('is hidden otherwise', () => {
    expect(state('hidden', null)).toBe('hidden');
    expect(state('hidden', attempt('noop', 'something_else'))).toBe('hidden');
  });
  it('canUnhide only for hidden and failed', () => {
    expect(HIDDEN_ROW_STATES.filter(canUnhide)).toEqual(['hidden', 'failed']);
  });
  it('lists every state', () => {
    expect(HIDDEN_ROW_STATES).toEqual([
      'hidden',
      'pending',
      'restored',
      'already_visible',
      'unavailable',
      'failed',
    ]);
  });
});
