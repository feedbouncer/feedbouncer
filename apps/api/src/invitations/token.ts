import { createHash, randomBytes } from 'node:crypto';

export const INVITATION_TTL_DAYS = 7;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** The raw token only goes into the invitation email; only its hash is stored. */
export function newInvitationToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function hashInvitationToken(token: unknown): Buffer | null {
  return typeof token === 'string' && TOKEN.test(token) ? sha256(token) : null;
}
