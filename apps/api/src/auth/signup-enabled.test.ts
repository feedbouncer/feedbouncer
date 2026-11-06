import { describe, expect, it, vi } from 'vitest';
import { parseSignupEnabled, SIGNUP_ENABLED_WARNING } from './signup-enabled.js';

describe('parseSignupEnabled', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['   ', true],
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['On', true],
    ['false', false],
    ['False', false],
    ['0', false],
    ['no', false],
    ['off', false],
    [' OFF ', false],
  ])('%j -> %s without warning', (raw, expected) => {
    const warn = vi.fn();
    expect(parseSignupEnabled(raw, warn)).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['flase', 'disabled', '2', 'nope'])(
    'unrecognized %j keeps sign-up on and warns once without the value',
    (raw) => {
      const warn = vi.fn();
      expect(parseSignupEnabled(raw, warn)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(SIGNUP_ENABLED_WARNING);
      expect(warn.mock.calls[0]![0]).not.toContain(raw);
    },
  );
});
