import { describe, expect, it } from 'vitest';
import { isClientRequestKey } from './actions.js';

describe('isClientRequestKey', () => {
  it.each([
    'auto:',
    'undo:',
    'review:',
    'clf:',
    'pol:',
    'rule-eval:',
    'suggestion:',
    'review_end:',
    'unhide:',
  ])('refuses the server-derived prefix %s', (prefix) => {
    expect(isClientRequestKey(`${prefix}abc`)).toBe(false);
  });

  it('accepts well-formed client keys, including manual: ones', () => {
    for (const key of ['k1', 'manual:abc', 'ui-123', 'a.b_c-d'])
      expect(isClientRequestKey(key)).toBe(true);
  });

  it('refuses malformed keys', () => {
    for (const key of ['', 'bad key', 'x'.repeat(129), 42, null])
      expect(isClientRequestKey(key)).toBe(false);
  });
});
