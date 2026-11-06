import { describe, expect, it } from 'vitest';
import { classifyFailure } from './api-failure';

describe('classifyFailure', () => {
  it.each([
    [403, 'organization_suspended', 'suspended'],
    [404, null, 'not_found'],
    [403, 'forbidden', 'error'],
    [500, 'organization_suspended', 'error'],
  ] as const)('maps %s %s to %s', (status, code, expected) => {
    expect(classifyFailure(status, code)).toBe(expected);
  });
});
