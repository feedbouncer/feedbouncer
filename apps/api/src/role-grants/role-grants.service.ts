import { Inject, Injectable } from '@nestjs/common';
import { can, isCapability, isRole, type Capability, type Role } from '@feedbouncer/authz';
import { withTransaction } from '@feedbouncer/db';
import type pg from 'pg';
import { recordAudit } from '../audit/audit.js';
import type { AppDeps } from '../deps.js';
import { ApiError } from '../http/errors.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { lockedActor } from '../tenancy/org-lock.js';
import { DEPS } from '../tokens.js';

export interface RoleGrantDto {
  role: Role;
  capability: Capability;
}

export interface RoleGrantChange extends RoleGrantDto {
  granted: boolean;
}

async function list(db: pg.Pool | pg.PoolClient, organizationId: string): Promise<RoleGrantDto[]> {
  const { rows } = await db.query<{ role: string; capability: string }>(
    'SELECT role, capability FROM role_grant WHERE organization_id = $1 ORDER BY role, capability',
    [organizationId],
  );
  return rows.flatMap((r) =>
    isRole(r.role) && isCapability(r.capability)
      ? [{ role: r.role, capability: r.capability }]
      : [],
  );
}

@Injectable()
export class RoleGrantsService {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  list(ctx: OrgContext): Promise<RoleGrantDto[]> {
    return list(this.deps.pool, ctx.organizationId);
  }

  set(ctx: OrgContext, change: RoleGrantChange): Promise<RoleGrantDto[]> {
    return withTransaction(this.deps.pool, async (c) => {
      if (!can(await lockedActor(c, ctx), 'member.change_role'))
        throw new ApiError(403, 'forbidden');
      const { rowCount } = change.granted
        ? await c.query(
            `INSERT INTO role_grant (organization_id, role, capability, granted_by_user_id)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [ctx.organizationId, change.role, change.capability, ctx.actorUserId],
          )
        : await c.query(
            'DELETE FROM role_grant WHERE organization_id = $1 AND role = $2 AND capability = $3',
            [ctx.organizationId, change.role, change.capability],
          );
      if (rowCount) {
        await recordAudit(c, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.actorUserId,
          action: 'org.role_grant_changed',
          subjectType: 'organization',
          subjectId: ctx.organizationId,
          details: { role: change.role, capability: change.capability, granted: change.granted },
        });
      }
      return list(c, ctx.organizationId);
    });
  }
}
