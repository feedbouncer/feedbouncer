import { describe, expect, it } from 'vitest';
import { isOwnerRequiredViolation, isUniqueViolation } from './pg-errors.js';

describe('pg error helpers', () => {
  it('matches unique violations by constraint name', () => {
    const e = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'brand_organization_id_name_key',
    });
    expect(isUniqueViolation(e, 'brand_organization_id_name_key')).toBe(true);
    expect(isUniqueViolation(e, 'other')).toBe(false);
    expect(isUniqueViolation(new Error('x'), 'brand_organization_id_name_key')).toBe(false);
  });
  it('matches the owner-required trigger', () => {
    const e = Object.assign(new Error('x'), {
      code: '23514',
      constraint: 'membership_owner_required',
    });
    expect(isOwnerRequiredViolation(e)).toBe(true);
    expect(isOwnerRequiredViolation({ code: '23514', constraint: 'brand_name_check' })).toBe(false);
  });
});
