import type pg from 'pg';

/**
 * Whether this normalized address may create an account: always when no
 * allowlist is set, otherwise when it is listed or holds a pending invitation.
 */
export async function isSignupAllowed(
  pool: pg.Pool,
  allowlist: ReadonlySet<string> | null,
  email: string,
): Promise<boolean> {
  if (allowlist === null || allowlist.has(email)) return true;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM invitation
      WHERE lower(email) = $1 AND status = 'pending' AND expires_at > now() LIMIT 1`,
    [email],
  );
  return rowCount === 1;
}
