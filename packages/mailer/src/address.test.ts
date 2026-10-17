import { describe, expect, it } from 'vitest';
import { normalizeAddress } from './address.js';

describe('normalizeAddress', () => {
  it('trims and lowercases', () => expect(normalizeAddress('  Ana@X.com ')).toBe('ana@x.com'));
  it.each([
    '',
    'no-at',
    '@x.com',
    'a@',
    'a b@x.com',
    'ä@x.com',
    'a@x.com\r\nBcc: v@x.com',
    'a@b,c@d',
    `${'a'.repeat(65)}@x.com`,
    `a@${'b'.repeat(250)}.com`,
    42,
    null,
  ])('rejects %j', (v) => expect(normalizeAddress(v)).toBeNull());
});
