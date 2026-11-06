import { messageFor } from './messages';
import { safeNextPath } from './safe-next';
import { serverGet } from './server-api';

export const SIGNUP_DISABLED_TEXT = messageFor('signup_disabled');

// Mirrors the API's invitation token format (apps/api/src/invitations/token.ts).
const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether to offer sign-up. Only a clear "disabled" answer hides it: when the
 * API cannot be read the normal form shows and the server still decides.
 */
export async function loadSignupEnabled(): Promise<boolean> {
  try {
    const r = await serverGet<{ enabled: boolean }>('/api/v1/auth/sign-up');
    return !(r.status === 200 && r.data?.enabled === false);
  } catch {
    return true;
  }
}

export function invitationTokenFrom(raw: unknown): string | null {
  return typeof raw === 'string' && INVITATION_TOKEN.test(raw) ? raw : null;
}

/** The token of an `/invite?token=…` path, if `next` is one. */
export function invitationTokenFromNext(next: string | null): string | null {
  if (!next) return null;
  const path = safeNextPath(next, '');
  const url = new URL(path, 'http://local.invalid');
  return url.pathname === '/invite' ? invitationTokenFrom(url.searchParams.get('token')) : null;
}
