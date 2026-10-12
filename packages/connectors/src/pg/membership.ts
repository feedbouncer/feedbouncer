import type pg from 'pg';
import { isRole, type Role } from '@feedbouncer/authz';
import type { MembershipReader } from '../ports.js';

export class PgMembershipReader implements MembershipReader {
  constructor(private readonly pool: pg.Pool) {}

  async roleInBrand(organizationId: string, brandId: string, userId: string): Promise<Role | null> {
    const r = await this.pool.query<{ role: string }>(
      `SELECT m.role FROM membership m
         JOIN brand b ON b.organization_id = m.organization_id
        WHERE m.organization_id = $1 AND b.id = $2 AND m.user_id = $3`,
      [organizationId, brandId, userId],
    );
    const role = r.rows[0]?.role;
    return isRole(role) ? role : null;
  }
}
