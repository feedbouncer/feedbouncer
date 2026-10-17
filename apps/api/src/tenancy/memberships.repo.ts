import { isCapability, isRole, type Capability, type Role } from '@feedbouncer/authz';
import type { Queryable } from '../auth/users.repo.js';

export async function findMembership(
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<{ role: Role; grants: Capability[] } | null> {
  const { rows } = await db.query<{ role: string; grants: string[] }>(
    `SELECT m.role,
            COALESCE(array_agg(g.capability) FILTER (WHERE g.capability IS NOT NULL), '{}') AS grants
       FROM membership m
       LEFT JOIN role_grant g ON g.organization_id = m.organization_id AND g.role = m.role
      WHERE m.organization_id = $1 AND m.user_id = $2
      GROUP BY m.role`,
    [organizationId, userId],
  );
  const row = rows[0];
  return row && isRole(row.role)
    ? { role: row.role, grants: row.grants.filter(isCapability) }
    : null;
}
