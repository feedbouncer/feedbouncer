import { Inject, Injectable } from '@nestjs/common';
import { canChangeRole, canRemoveMember, type Denial, type Role } from '@feedbouncer/authz';
import { isOwnerRequiredViolation, withTransaction } from '@feedbouncer/db';
import type pg from 'pg';
import { recordAudit } from '../audit/audit.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { currentRole, lockedActor } from '../tenancy/org-lock.js';
import { DEPS } from '../tokens.js';
import { MEMBER_SELECT, toMemberDto, type MemberDto, type MemberRow } from './dto.js';

const lastOwner = () => new ApiError(409, 'last_owner');
const denied = (reason: Denial) => new ApiError(403, reason);

async function ownerCount(c: pg.PoolClient, organizationId: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM membership WHERE organization_id = $1 AND role = 'owner'",
    [organizationId],
  );
  return rows[0]!.n;
}

// The database trigger is the backstop for the last-owner rule, including at commit.
async function mapOwnerViolation<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    throw isOwnerRequiredViolation(e) ? lastOwner() : e;
  }
}

async function one(c: pg.PoolClient, organizationId: string, userId: string): Promise<MemberDto> {
  const { rows } = await c.query<MemberRow>(
    `${MEMBER_SELECT} WHERE m.organization_id = $1 AND m.user_id = $2`,
    [organizationId, userId],
  );
  if (!rows[0]) throw notFound();
  return toMemberDto(rows[0]);
}

@Injectable()
export class MembersService {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  async list(ctx: OrgContext): Promise<MemberDto[]> {
    const { rows } = await this.deps.pool.query<MemberRow>(
      `${MEMBER_SELECT} WHERE m.organization_id = $1 ORDER BY lower(u.email), m.user_id`,
      [ctx.organizationId],
    );
    return rows.map(toMemberDto);
  }

  changeRole(ctx: OrgContext, targetUserId: string, role: Role): Promise<MemberDto> {
    return mapOwnerViolation(
      withTransaction(this.deps.pool, async (c) => {
        const actor = await lockedActor(c, ctx);
        const target = await currentRole(c, ctx.organizationId, targetUserId);
        if (!target) throw notFound();
        const d = canChangeRole(actor, target, role);
        if (!d.ok) throw denied(d.reason);
        if (target === role) return one(c, ctx.organizationId, targetUserId);
        if (target === 'owner' && (await ownerCount(c, ctx.organizationId)) === 1) {
          throw lastOwner();
        }
        await c.query(
          'UPDATE membership SET role = $3 WHERE organization_id = $1 AND user_id = $2',
          [ctx.organizationId, targetUserId, role],
        );
        await recordAudit(c, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.actorUserId,
          action: 'membership.role_changed',
          subjectType: 'membership',
          subjectId: targetUserId,
          details: { from: target, to: role },
        });
        return one(c, ctx.organizationId, targetUserId);
      }),
    );
  }

  async remove(ctx: OrgContext, targetUserId: string): Promise<void> {
    await mapOwnerViolation(
      withTransaction(this.deps.pool, async (c) => {
        const actor = await lockedActor(c, ctx);
        const target = await currentRole(c, ctx.organizationId, targetUserId);
        if (!target) throw notFound();
        // Self-removal (leaving) is derived from the session user, never from input.
        const self = targetUserId === ctx.actorUserId;
        const d = canRemoveMember(actor, target, self);
        if (!d.ok) throw denied(d.reason);
        if (target === 'owner' && (await ownerCount(c, ctx.organizationId)) === 1) {
          throw lastOwner();
        }
        await c.query('DELETE FROM membership WHERE organization_id = $1 AND user_id = $2', [
          ctx.organizationId,
          targetUserId,
        ]);
        await recordAudit(c, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.actorUserId,
          action: self ? 'membership.left' : 'membership.removed',
          subjectType: 'membership',
          subjectId: targetUserId,
          details: { role: target },
        });
      }),
    );
  }

  async transferOwnership(ctx: OrgContext, toUserId: string, newRoleForSelf: Role): Promise<void> {
    await mapOwnerViolation(
      withTransaction(this.deps.pool, async (c) => {
        if ((await lockedActor(c, ctx)) !== 'owner') throw new ApiError(403, 'forbidden');
        if (toUserId === ctx.actorUserId) {
          throw new ApiError(400, 'invalid_request', 'Choose another member.');
        }
        if (!(await currentRole(c, ctx.organizationId, toUserId))) throw notFound();
        await c.query(
          "UPDATE membership SET role = 'owner' WHERE organization_id = $1 AND user_id = $2",
          [ctx.organizationId, toUserId],
        );
        if (newRoleForSelf !== 'owner') {
          await c.query(
            'UPDATE membership SET role = $3 WHERE organization_id = $1 AND user_id = $2',
            [ctx.organizationId, ctx.actorUserId, newRoleForSelf],
          );
        }
        await recordAudit(c, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.actorUserId,
          action: 'organization.ownership_transferred',
          subjectType: 'organization',
          subjectId: ctx.organizationId,
          details: { toUserId, newRoleForSelf },
        });
      }),
    );
  }
}
