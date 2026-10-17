// ASCII-only: JS toLowerCase and Postgres lower() disagree on some non-ASCII
// letters, which would split one person into two accounts.
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Trimmed, lowercased address, or null when it is not a single plain mailbox. */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return v.length <= 254 && v.indexOf('@') <= 64 && ADDRESS.test(v) ? v : null;
}
