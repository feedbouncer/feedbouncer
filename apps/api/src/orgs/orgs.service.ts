import { Inject, Injectable } from '@nestjs/common';
import { can, type Role } from '@feedbouncer/authz';
import { withTransaction } from '@feedbouncer/db';
import { recordAudit } from '../audit/audit.js';
import { requireVerified, type AuthedUser } from '../auth/session.guard.js';
import { BRAND_COLUMNS, toBrandDto, type BrandDto, type BrandRow } from '../brands/dto.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { lockedActor } from '../tenancy/org-lock.js';
import { DEPS } from '../tokens.js';
import { ORG_COLUMNS, toOrgDto, type OrgDto, type OrgRow } from './dto.js';

@Injectable()
export class OrgsService {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  async create(
    user: AuthedUser,
    input: { name: string; brandName?: string | undefined },
  ): Promise<{ organization: OrgDto; brand: BrandDto | null }> {
    requireVerified(user);
    return withTransaction(this.deps.pool, async (c) => {
      const org = (
        await c.query<OrgRow>(
          `INSERT INTO organization (name) VALUES ($1) RETURNING ${ORG_COLUMNS}`,
          [input.name],
        )
      ).rows[0]!;
      await c.query(
        "INSERT INTO membership (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
        [org.id, user.id],
      );
      await recordAudit(c, {
        organizationId: org.id,
        actorUserId: user.id,
        action: 'organization.created',
        subjectType: 'organization',
        subjectId: org.id,
      });
      let brand: BrandDto | null = null;
      if (input.brandName) {
        const row = (
          await c.query<BrandRow>(
            `INSERT INTO brand (organization_id, name) VALUES ($1, $2) RETURNING ${BRAND_COLUMNS}`,
            [org.id, input.brandName],
          )
        ).rows[0]!;
        brand = toBrandDto(row);
        await recordAudit(c, {
          organizationId: org.id,
          brandId: row.id,
          actorUserId: user.id,
          action: 'brand.created',
          subjectType: 'brand',
          subjectId: row.id,
        });
      }
      return { organization: toOrgDto(org), brand };
    });
  }

  async listMine(userId: string): Promise<Array<{ organization: OrgDto; role: Role }>> {
    const { rows } = await this.deps.pool.query<OrgRow & { role: Role }>(
      `SELECT o.id, o.name, o.created_at, m.role
         FROM membership m JOIN organization o ON o.id = m.organization_id
        WHERE m.user_id = $1 ORDER BY o.name, o.id`,
      [userId],
    );
    return rows.map((r) => ({ organization: toOrgDto(r), role: r.role }));
  }

  async get(ctx: OrgContext): Promise<{ organization: OrgDto; role: Role }> {
    const { rows } = await this.deps.pool.query<OrgRow>(
      `SELECT ${ORG_COLUMNS} FROM organization WHERE id = $1`,
      [ctx.organizationId],
    );
    if (!rows[0]) throw notFound();
    return { organization: toOrgDto(rows[0]), role: ctx.role };
  }

  async rename(ctx: OrgContext, name: string): Promise<OrgDto> {
    return withTransaction(this.deps.pool, async (c) => {
      if (!can(await lockedActor(c, ctx), 'org.update')) throw new ApiError(403, 'forbidden');
      const row = (
        await c.query<OrgRow>(
          `UPDATE organization SET name = $2 WHERE id = $1 RETURNING ${ORG_COLUMNS}`,
          [ctx.organizationId, name],
        )
      ).rows[0];
      if (!row) throw notFound();
      await recordAudit(c, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.actorUserId,
        action: 'organization.renamed',
        subjectType: 'organization',
        subjectId: ctx.organizationId,
      });
      return toOrgDto(row);
    });
  }

  async remove(ctx: OrgContext, confirmName: string): Promise<void> {
    await withTransaction(this.deps.pool, async (c) => {
      // The role is re-read under the lock: the guard's copy may be stale.
      if (!can(await lockedActor(c, ctx), 'org.delete')) throw new ApiError(403, 'forbidden');
      const { rows } = await c.query<{ name: string }>(
        'SELECT name FROM organization WHERE id = $1',
        [ctx.organizationId],
      );
      if (rows[0]?.name !== confirmName.trim()) throw new ApiError(400, 'confirmation_mismatch');
      await c.query('DELETE FROM organization WHERE id = $1', [ctx.organizationId]);
    });
    this.deps.log.info('organization deleted', {
      organizationId: ctx.organizationId,
      actorUserId: ctx.actorUserId,
    });
  }
}
