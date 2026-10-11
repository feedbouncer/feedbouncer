import { ApiError } from '../http/errors.js';

// ASCII-only in this iteration: JS toLowerCase and Postgres lower() disagree on
// some non-ASCII letters, which would split one person into two accounts.
const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Trimmed, lowercased address as stored in app_user.email; 400 invalid_email otherwise. */
export function normalizeEmail(raw: unknown): string {
  const invalid = () => new ApiError(400, 'invalid_email');
  if (typeof raw !== 'string') throw invalid();
  const v = raw.trim().toLowerCase();
  if (v.length > 254 || !EMAIL.test(v) || v.indexOf('@') > 64) throw invalid();
  return v;
}
