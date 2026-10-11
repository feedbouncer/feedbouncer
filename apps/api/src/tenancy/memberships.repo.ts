import { isRole, type Role } from '@feedbouncer/authz';
import type { Queryable } from '../auth/users.repo.js';

export async function findMembership(
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<{ role: Role } | null> {
  const { rows } = await db.query<{ role: string }>(
    'SELECT role FROM membership WHERE organization_id = $1 AND user_id = $2',
    [organizationId, userId],
  );
  const role = rows[0]?.role;
  return isRole(role) ? { role } : null;
}
