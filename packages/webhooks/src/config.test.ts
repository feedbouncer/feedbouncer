import { describe, expect, it } from 'vitest';
import { readAllowedPrivateCidrs } from './config.js';

describe('readAllowedPrivateCidrs', () => {
  it('is empty when unset or blank', () => {
    expect(readAllowedPrivateCidrs({})).toEqual([]);
    expect(readAllowedPrivateCidrs({ WEBHOOK_ALLOWED_PRIVATE_CIDRS: '  ' })).toEqual([]);
  });

  it('trims a comma-separated list and ignores a trailing comma', () => {
    expect(
      readAllowedPrivateCidrs({ WEBHOOK_ALLOWED_PRIVATE_CIDRS: ' 10.0.0.0/8 , 192.168.1.5/32,' }),
    ).toEqual(['10.0.0.0/8', '192.168.1.5/32']);
  });

  it.each(['10.0.0.0', '10.0.0.0/33', 'banana', '10.0.0.0/8,,300.1.1.1/8'])(
    'throws naming the variable for %s',
    (bad) => {
      expect(() => readAllowedPrivateCidrs({ WEBHOOK_ALLOWED_PRIVATE_CIDRS: bad })).toThrow(
        /WEBHOOK_ALLOWED_PRIVATE_CIDRS/,
      );
    },
  );
});
