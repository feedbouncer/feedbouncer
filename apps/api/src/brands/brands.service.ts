import { Inject, Injectable } from '@nestjs/common';
import { can } from '@feedbouncer/authz';
import { isUniqueViolation, withTransaction } from '@feedbouncer/db';
import type pg from 'pg';
import { recordAudit } from '../audit/audit.js';
import type { AppDeps } from '../deps.js';
import { ApiError, notFound } from '../http/errors.js';
import type { OrgContext } from '../tenancy/org-access.guard.js';
import { lockedActor } from '../tenancy/org-lock.js';
import { DEPS } from '../tokens.js';
import { BRAND_COLUMNS, toBrandDto, type BrandDto, type BrandRow } from './dto.js';

export const BRAND_NAME_INDEX = 'brand_organization_id_name_key';

const taken = () =>
  new ApiError(
    409,
    'brand_name_taken',
    'A brand with this name already exists in this organization.',
  );

// The role is re-read under the organization lock: the guard's copy may be stale.
async function lockedWriter(c: pg.PoolClient, ctx: OrgContext): Promise<void> {
  if (!can(await lockedActor(c, ctx), 'brand.write')) throw new ApiError(403, 'forbidden');
}

@Injectable()
export class BrandsService {
  constructor(@Inject(DEPS) private readonly deps: AppDeps) {}

  async list(ctx: OrgContext, includeArchived: boolean): Promise<BrandDto[]> {
    const { rows } = await this.deps.pool.query<BrandRow>(
      `SELECT ${BRAND_COLUMNS} FROM brand
        WHERE organization_id = $1 AND ($2::boolean OR archived_at IS NULL)
        ORDER BY lower(name), id`,
      [ctx.organizationId, includeArchived],
    );
    return rows.map(toBrandDto);
  }

  async get(ctx: OrgContext, brandId: string): Promise<BrandDto> {
    const { rows } = await this.deps.pool.query<BrandRow>(
      `SELECT ${BRAND_COLUMNS} FROM brand WHERE organization_id = $1 AND id = $2`,
      [ctx.organizationId, brandId],
    );
    if (!rows[0]) throw notFound();
    return toBrandDto(rows[0]);
  }

  async create(ctx: OrgContext, name: string): Promise<BrandDto> {
    try {
      return await withTransaction(this.deps.pool, async (c) => {
        await lockedWriter(c, ctx);
        const row = (
          await c.query<BrandRow>(
            `INSERT INTO brand (organization_id, name) VALUES ($1, $2) RETURNING ${BRAND_COLUMNS}`,
            [ctx.organizationId, name],
          )
        ).rows[0]!;
        await recordAudit(c, {
          organizationId: ctx.organizationId,
          brandId: row.id,
          actorUserId: ctx.actorUserId,
          action: 'brand.created',
          subjectType: 'brand',
          subjectId: row.id,
        });
        return toBrandDto(row);
      });
    } catch (e) {
      if (isUniqueViolation(e, BRAND_NAME_INDEX)) throw taken();
      throw e;
    }
  }

  async rename(ctx: OrgContext, brandId: string, name: string): Promise<BrandDto> {
    try {
      return await withTransaction(this.deps.pool, async (c) => {
        await lockedWriter(c, ctx);
        const cur = (
          await c.query<BrandRow>(
            `SELECT ${BRAND_COLUMNS} FROM brand WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
            [ctx.organizationId, brandId],
          )
        ).rows[0];
        if (!cur) throw notFound();
        if (cur.archived_at) {
          throw new ApiError(409, 'brand_archived', 'Archived brands cannot be renamed.');
        }
        const row = (
          await c.query<BrandRow>(
            `UPDATE brand SET name = $3 WHERE organization_id = $1 AND id = $2 RETURNING ${BRAND_COLUMNS}`,
            [ctx.organizationId, brandId, name],
          )
        ).rows[0]!;
        await recordAudit(c, {
          organizationId: ctx.organizationId,
          brandId,
          actorUserId: ctx.actorUserId,
          action: 'brand.renamed',
          subjectType: 'brand',
          subjectId: brandId,
        });
        return toBrandDto(row);
      });
    } catch (e) {
      if (isUniqueViolation(e, BRAND_NAME_INDEX)) throw taken();
      throw e;
    }
  }

  async archive(ctx: OrgContext, brandId: string): Promise<BrandDto> {
    return withTransaction(this.deps.pool, async (c) => {
      await lockedWriter(c, ctx);
      const updated = (
        await c.query<BrandRow>(
          `UPDATE brand SET archived_at = now()
            WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL
            RETURNING ${BRAND_COLUMNS}`,
          [ctx.organizationId, brandId],
        )
      ).rows[0];
      if (updated) {
        await recordAudit(c, {
          organizationId: ctx.organizationId,
          brandId,
          actorUserId: ctx.actorUserId,
          action: 'brand.archived',
          subjectType: 'brand',
          subjectId: brandId,
        });
        return toBrandDto(updated);
      }
      const existing = (
        await c.query<BrandRow>(
          `SELECT ${BRAND_COLUMNS} FROM brand WHERE organization_id = $1 AND id = $2`,
          [ctx.organizationId, brandId],
        )
      ).rows[0];
      if (!existing) throw notFound();
      return toBrandDto(existing); // already archived: idempotent
    });
  }
}
