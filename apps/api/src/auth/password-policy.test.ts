import { describe, expect, it } from 'vitest';
import { assertPassword, checkPassword } from './password-policy.js';

describe('checkPassword', () => {
  it('rejects under 12 code points', () =>
    expect(checkPassword('Ab1!Ab1!Ab1', [])).toBe('password_too_short'));
  it('counts code points, not UTF-16 units', () =>
    expect(checkPassword('🔒'.repeat(11), [])).toBe('password_too_short'));
  it('rejects over 128', () =>
    expect(checkPassword('x'.repeat(129), [])).toBe('password_too_long'));
  it.each(['password1234', 'qwertyuiop12', '111111111111', 'feedbouncer2026'])(
    'rejects common %s',
    (pw) => expect(checkPassword(pw, [])).toBe('weak_password'),
  );
  it('rejects a password built from the email', () =>
    expect(checkPassword('ana.smith@acme.test1', ['ana.smith@acme.test'])).toBe('weak_password'));
  it('accepts a long passphrase', () =>
    expect(checkPassword('correct horse battery staple 42', [])).toBeNull());
});

describe('assertPassword', () => {
  it('throws 422 with the problem code', () => {
    expect(() => assertPassword('short', [])).toThrow(
      expect.objectContaining({ status: 422, code: 'password_too_short' }),
    );
    expect(() => assertPassword('correct horse battery staple 42', [])).not.toThrow();
  });
});
