import { describe, expect, it } from 'vitest';
import { hashInvitationToken, newInvitationToken } from './token.js';

describe('invitation tokens', () => {
  it('generates a 43-character base64url token with a 32-byte hash', () => {
    const { token, hash } = newInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toHaveLength(32);
    expect(hashInvitationToken(token)).toEqual(hash);
  });

  it('generates a different token every time', () => {
    expect(newInvitationToken().token).not.toBe(newInvitationToken().token);
  });

  it('rejects anything that is not a 43-character base64url string', () => {
    expect(hashInvitationToken('short')).toBeNull();
    expect(hashInvitationToken(null)).toBeNull();
    expect(hashInvitationToken(`${'A'.repeat(42)}/`)).toBeNull();
    expect(hashInvitationToken(`${'A'.repeat(43)}\n`)).toBeNull();
  });
});
