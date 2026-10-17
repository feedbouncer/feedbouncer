import { normalizeAddress } from '@feedbouncer/mailer';
import { ApiError } from '../http/errors.js';

/** Trimmed, lowercased address as stored in app_user.email; 400 invalid_email otherwise. */
export function normalizeEmail(raw: unknown): string {
  const email = normalizeAddress(raw);
  if (email === null) throw new ApiError(400, 'invalid_email');
  return email;
}
