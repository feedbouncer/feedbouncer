import { Inject, Injectable } from '@nestjs/common';
import { recordProvisioningAudit } from '@feedbouncer/db';
import type { AppDeps } from '../deps.js';
import { notFound } from '../http/errors.js';
import { DEPS } from '../tokens.js';
import {
  ORGANIZATION_COLUMNS,
  USER_COLUMNS,
  toProvisionedOrganization,
  toProvisionedUser,
  type MembershipRow,
  type OrganizationRow,
  type ProvisionedOrganization,
  type ProvisionedUser,
  type UserRow,
} from './dto.js';

/**
 * The provisioning operations. Each success writes its own provisioning audit row;
 * errors are audited by the controller.
 */
@Injectable()
export class ProvisioningService {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  async getOrganization(fp: string, id: string): Promise<ProvisionedOrganization> {
    const { rows } = await this.deps.pool.query<OrganizationRow>(
      `SELECT ${ORGANIZATION_COLUMNS} FROM organization WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound();
    await this.audit(fp, 'organization.read', 'organization', id);
    return toProvisionedOrganization(rows[0]);
  }

  async getUser(fp: string, id: string): Promise<ProvisionedUser> {
    const { rows } = await this.deps.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM app_user WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound();
    const memberships = await this.deps.pool.query<MembershipRow>(
      `SELECT m.organization_id, m.role, o.status AS organization_status
         FROM membership m JOIN organization o ON o.id = m.organization_id
        WHERE m.user_id = $1 ORDER BY m.created_at, m.organization_id`,
      [id],
    );
    await this.audit(fp, 'user.read', 'user', id);
    return toProvisionedUser(rows[0], memberships.rows);
  }

  private audit(
    credentialFingerprint: string,
    action: 'organization.read' | 'user.read',
    targetType: 'organization' | 'user',
    targetId: string,
  ): Promise<void> {
    return recordProvisioningAudit(this.deps.pool, {
      action,
      targetType,
      targetId,
      outcome: 'read',
      credentialFingerprint,
    });
  }
}
