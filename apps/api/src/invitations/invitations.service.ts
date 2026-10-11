import { Inject, Injectable } from '@nestjs/common';
import { canInviteWithRole, canManageInvitation, type Role } from '@feedbouncer/authz';
import { withTransaction } from '@feedbouncer/db';
import { recordAudit } from '../audit/audit.js';
import { normalizeEmail } from '../auth/email.js';
import type { AuthRateLimits } from '../auth/rate-limit.js';
import { requireVerified, type AuthedUser } from '../auth/session.guard.js';
import type { AuthEmails } from '../auth/emails.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { currentRole, lockedActor, lockOrganization } from '../tenancy/org-lock.js';
import { AUTH_EMAILS, DEPS, RATE_LIMITS } from '../tokens.js';
import {
  INVITATION_COLUMNS,
  toInvitationDto,
  type InvitationDto,
  type InvitationRow,
} from './dto.js';
import { hashInvitationToken, INVITATION_TTL_DAYS, newInvitationToken } from './token.js';

export type CreateResult =
  | { status: 'created' | 'renewed'; invitation: InvitationDto; emailSent: boolean }
  | { status: 'already_member' };

// A wrong, expired, revoked or used token all look the same: no oracle.
const pending = (alias = '') => `${alias}status = 'pending' AND ${alias}expires_at > now()`;

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DEPS) private readonly deps: AppDeps,
    @Inject(AUTH_EMAILS) private readonly emails: AuthEmails,
    @Inject(RATE_LIMITS) private readonly limits: AuthRateLimits,
  ) {}

  async create(ctx: OrgContext, rawEmail: string, role: Role, ip: string): Promise<CreateResult> {
    const email = normalizeEmail(rawEmail);
    const { token, hash } = newInvitationToken();
    // Before anything is written: Redis trouble fails the request with nothing
    // changed, and a rate-limited send must not rotate (and so kill) the link
    // that was already emailed. Spent on an already-member or forbidden request
    // too, which only makes the budget stricter.
    let emailSent = true;
    try {
      await this.limits.consumeEmailSend(email, ip);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'rate_limited') emailSent = false;
      else throw e;
    }
    const result = await withTransaction(this.deps.pool, async (c) => {
      const actor = await lockedActor(c, ctx);
      const allowed = canInviteWithRole(actor, role);
      if (!allowed.ok) throw new ApiError(403, allowed.reason);
      const member = await c.query(
        `SELECT 1 FROM membership m JOIN app_user u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND u.email = $2`,
        [ctx.organizationId, email],
      );
      if (member.rowCount) return { status: 'already_member' as const };
      const existing = (
        await c.query<{ role: Role }>(
          `SELECT role FROM invitation
            WHERE organization_id = $1 AND email = $2 AND status = 'pending' FOR UPDATE`,
          [ctx.organizationId, email],
        )
      ).rows[0];
      if (existing) {
        const manageable = canManageInvitation(actor, existing.role);
        if (!manageable.ok) throw new ApiError(403, manageable.reason);
      }
      const row = (
        await c.query<InvitationRow>(
          `INSERT INTO invitation (organization_id, email, role, token_hash, expires_at, invited_by_user_id)
           VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), $6)
           ON CONFLICT (organization_id, email) WHERE status = 'pending'
           DO UPDATE SET role = EXCLUDED.role,
                         token_hash = CASE WHEN $7 THEN EXCLUDED.token_hash ELSE invitation.token_hash END,
                         expires_at = EXCLUDED.expires_at, invited_by_user_id = EXCLUDED.invited_by_user_id
           RETURNING ${INVITATION_COLUMNS}`,
          [ctx.organizationId, email, role, hash, INVITATION_TTL_DAYS, ctx.actorUserId, emailSent],
        )
      ).rows[0]!;
      await recordAudit(c, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.actorUserId,
        action: existing ? 'invitation.renewed' : 'invitation.created',
        subjectType: 'invitation',
        subjectId: row.id,
        details: { role },
      });
      const org = (
        await c.query<{ name: string }>('SELECT name FROM organization WHERE id = $1', [
          ctx.organizationId,
        ])
      ).rows[0]!;
      const inviter = (
        await c.query<{ display_name: string | null }>(
          'SELECT display_name FROM app_user WHERE id = $1',
          [ctx.actorUserId],
        )
      ).rows[0];
      return {
        status: existing ? ('renewed' as const) : ('created' as const),
        invitation: toInvitationDto(row),
        organizationName: org.name,
        inviterName: inviter?.display_name ?? null,
      };
    });
    if (result.status === 'already_member') return result;

    if (emailSent) {
      this.emails.invitation(email, {
        organizationName: result.organizationName,
        inviterName: result.inviterName,
        role,
        token,
      });
    }
    return { status: result.status, invitation: result.invitation, emailSent };
  }

  async listPending(ctx: OrgContext): Promise<InvitationDto[]> {
    const { rows } = await this.deps.pool.query<InvitationRow>(
      `SELECT ${INVITATION_COLUMNS} FROM invitation
        WHERE organization_id = $1 AND status = 'pending' ORDER BY created_at DESC, id`,
      [ctx.organizationId],
    );
    return rows.map(toInvitationDto);
  }

  async revoke(ctx: OrgContext, invitationId: string): Promise<void> {
    await withTransaction(this.deps.pool, async (c) => {
      const actor = await lockedActor(c, ctx);
      const inv = (
        await c.query<{ role: Role; status: string }>(
          'SELECT role, status FROM invitation WHERE organization_id = $1 AND id = $2 FOR UPDATE',
          [ctx.organizationId, invitationId],
        )
      ).rows[0];
      if (!inv) throw notFound();
      const manageable = canManageInvitation(actor, inv.role);
      if (!manageable.ok) throw new ApiError(403, manageable.reason);
      if (inv.status !== 'pending') throw new ApiError(409, 'invitation_not_pending');
      await c.query(
        "UPDATE invitation SET status = 'revoked', revoked_at = now() WHERE organization_id = $1 AND id = $2",
        [ctx.organizationId, invitationId],
      );
      await recordAudit(c, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.actorUserId,
        action: 'invitation.revoked',
        subjectType: 'invitation',
        subjectId: invitationId,
      });
    });
  }

  async lookup(
    user: AuthedUser,
    token: string,
  ): Promise<{ organizationName: string; role: Role; emailMatches: boolean }> {
    const hash = hashInvitationToken(token);
    if (!hash) throw notFound();
    const row = (
      await this.deps.pool.query<{ email: string; role: Role; name: string }>(
        `SELECT i.email, i.role, o.name FROM invitation i
           JOIN organization o ON o.id = i.organization_id
          WHERE i.token_hash = $1 AND ${pending('i.')}`,
        [hash],
      )
    ).rows[0];
    if (!row) throw notFound();
    return { organizationName: row.name, role: row.role, emailMatches: row.email === user.email };
  }

  async accept(user: AuthedUser, token: string): Promise<{ organizationId: string; role: Role }> {
    requireVerified(user);
    const hash = hashInvitationToken(token);
    if (!hash) throw notFound();
    return withTransaction(this.deps.pool, async (c) => {
      // Same lock order as create and revoke (organization, then invitation):
      // a plain read finds the organization, the row is locked and re-checked after.
      const found = (
        await c.query<{ organization_id: string }>(
          `SELECT organization_id FROM invitation WHERE token_hash = $1 AND ${pending()}`,
          [hash],
        )
      ).rows[0];
      if (!found || !(await lockOrganization(c, found.organization_id))) throw notFound();
      // A concurrent accept or revoke that committed first leaves no pending row here.
      const inv = (
        await c.query<{ id: string; email: string; role: Role }>(
          `SELECT id, email, role FROM invitation WHERE token_hash = $1 AND ${pending()} FOR UPDATE`,
          [hash],
        )
      ).rows[0];
      if (!inv) throw notFound();
      if (inv.email !== user.email) {
        throw new ApiError(403, 'invitation_email_mismatch');
      }
      const inserted = await c.query<{ role: Role }>(
        `INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO NOTHING RETURNING role`,
        [found.organization_id, user.id, inv.role],
      );
      const role =
        inserted.rows[0]?.role ?? (await currentRole(c, found.organization_id, user.id))!;
      await c.query(
        "UPDATE invitation SET status = 'accepted', accepted_at = now(), accepted_by_user_id = $2 WHERE id = $1",
        [inv.id, user.id],
      );
      await recordAudit(c, {
        organizationId: found.organization_id,
        actorUserId: user.id,
        action: 'invitation.accepted',
        subjectType: 'invitation',
        subjectId: inv.id,
        details: { joined: inserted.rowCount === 1, role },
      });
      return { organizationId: found.organization_id, role };
    });
  }
}
