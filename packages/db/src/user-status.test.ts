import { describe, expect, it } from 'vitest';
import { isUserActive, isUserStatus, userStatusOf } from './user-status.js';

describe('user status', () => {
  it.each([
    ['active', { status: 'active', recognized: true }],
    ['suspended', { status: 'suspended', recognized: true }],
    [null, { status: 'suspended', recognized: false }],
    [undefined, { status: 'suspended', recognized: false }],
    ['ACTIVE', { status: 'suspended', recognized: false }],
    ['', { status: 'suspended', recognized: false }],
    [1, { status: 'suspended', recognized: false }],
  ])('userStatusOf(%j) fails closed', (raw, expected) =>
    expect(userStatusOf(raw)).toEqual(expected),
  );

  it('isUserActive is true only for "active"', () => {
    expect(isUserActive('active')).toBe(true);
    expect(isUserActive('suspended')).toBe(false);
    expect(isUserActive(null)).toBe(false);
  });

  it('isUserStatus narrows to known statuses', () => {
    expect(isUserStatus('suspended')).toBe(true);
    expect(isUserStatus('paused')).toBe(false);
  });
});
