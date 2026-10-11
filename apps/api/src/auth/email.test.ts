import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './email.js';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => expect(normalizeEmail('  Ana@X.com ')).toBe('ana@x.com'));
  it.each([
    '',
    'no-at',
    '@x.com',
    'a@',
    'a b@x.com',
    'ä@x.com',
    'a@x.com\r\nBcc: v@x.com',
    'a'.repeat(310) + '@x.com',
    42,
    null,
  ])('rejects %j with 400 invalid_email', (v) => {
    expect(() => normalizeEmail(v)).toThrow(
      expect.objectContaining({ status: 400, code: 'invalid_email' }),
    );
  });
});
