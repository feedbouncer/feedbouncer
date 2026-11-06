import { describe, expect, it } from 'vitest';
import { isOrgActive, isOrgStatus, orgStatusOf } from './org-status.js';

describe('org status', () => {
  it.each([
    ['active', { status: 'active', recognized: true }],
    ['suspended', { status: 'suspended', recognized: true }],
    [null, { status: 'suspended', recognized: false }],
    [undefined, { status: 'suspended', recognized: false }],
    ['ACTIVE', { status: 'suspended', recognized: false }],
    ['', { status: 'suspended', recognized: false }],
    [1, { status: 'suspended', recognized: false }],
  ])('orgStatusOf(%j) fails closed', (raw, expected) => expect(orgStatusOf(raw)).toEqual(expected));

  it('isOrgActive is true only for "active"', () => {
    expect(isOrgActive('active')).toBe(true);
    expect(isOrgActive('suspended')).toBe(false);
    expect(isOrgActive(null)).toBe(false);
  });

  it('isOrgStatus narrows to known statuses', () => {
    expect(isOrgStatus('suspended')).toBe(true);
    expect(isOrgStatus('paused')).toBe(false);
  });
});
