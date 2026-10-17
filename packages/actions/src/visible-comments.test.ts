import { describe, expect, it } from 'vitest';
import { accountProblem } from './visible-comments.js';

const base = {
  status: 'active' as const,
  lastErrorClass: null,
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
};
const T1 = new Date('2026-10-16T10:00:00Z');
const T2 = new Date('2026-10-16T11:00:00Z');

describe('accountProblem', () => {
  it('is reconnect_required for reconnect_required, error and needs_reconnection', () => {
    expect(accountProblem({ ...base, status: 'reconnect_required' })).toBe('reconnect_required');
    expect(accountProblem({ ...base, status: 'error' })).toBe('reconnect_required');
    expect(accountProblem({ ...base, lastErrorClass: 'needs_reconnection' })).toBe(
      'reconnect_required',
    );
  });
  it('is sync_failing after 3 failures since the last success', () => {
    const failing = { ...base, consecutiveFailures: 3, lastFailureAt: T2, lastSuccessAt: T1 };
    expect(accountProblem(failing)).toBe('sync_failing');
    expect(accountProblem({ ...failing, lastSuccessAt: null })).toBe('sync_failing');
  });
  it('is null for 2 failures', () => {
    expect(
      accountProblem({ ...base, consecutiveFailures: 2, lastFailureAt: T2, lastSuccessAt: T1 }),
    ).toBeNull();
  });
  it('is null when the failure is older than the last success', () => {
    expect(
      accountProblem({ ...base, consecutiveFailures: 5, lastFailureAt: T1, lastSuccessAt: T2 }),
    ).toBeNull();
  });
  it('is null for a paused connection', () => {
    expect(accountProblem({ ...base, status: 'paused' })).toBeNull();
  });
});
