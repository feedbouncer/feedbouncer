import { describe, expect, it } from 'vitest';
import { isUuid } from './ids';

describe('isUuid', () => {
  it('accepts a uuid', () => {
    expect(isUuid('6f1c3a7e-1b2c-4d5e-8f90-123456789abc')).toBe(true);
  });
  it.each(['../../x', '', 'abc', '6f1c3a7e-1b2c-4d5e-8f90-123456789abc/..', 42, null, undefined])(
    'rejects %j',
    (value) => {
      expect(isUuid(value)).toBe(false);
    },
  );
});
