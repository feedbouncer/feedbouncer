import { Inject, Injectable } from '@nestjs/common';
import { removeBrandAlerts } from '@feedbouncer/alerts';
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

// Intl accepts names case-insensitively; date_trunc needs the exact name Postgres knows.
async function isKnownZone(c: pg.PoolClient, timezone: string): Promise<boolean> {
  const known = await c.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [timezone]);
  return known.rowCount !== 0;
}

async function requireKnownZone(c: pg.PoolClient, timezone: string): Promise<void> {
  if (!(await isKnownZone(c, timezone))) {
    throw new ApiError(400, 'invalid_request', 'Invalid or missing fields: timezone.');
  }
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

  async create(ctx: OrgContext, name: string, timezone?: string): Promise<BrandDto> {
    try {
      return await withTransaction(this.deps.pool, async (c) => {
        await lockedWriter(c, ctx);
        // The browser supplies the zone unprompted, so one this server doesn't know means UTC, not a failure.
        const zone = timezone && (await isKnownZone(c, timezone)) ? timezone : null;
        const row = (
          await c.query<BrandRow>(
            `INSERT INTO brand (organization_id, name, timezone, timezone_set_at)
             VALUES ($1, $2, COALESCE($3::text, 'UTC'), CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
             RETURNING ${BRAND_COLUMNS}`,
            [ctx.organizationId, name, zone],
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

  async update(
    ctx: OrgContext,
    brandId: string,
    patch: { name?: string | undefined; timezone?: string | undefined },
  ): Promise<BrandDto> {
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
          throw new ApiError(409, 'brand_archived', 'Archived brands cannot be changed.');
        }
        if (patch.timezone) await requireKnownZone(c, patch.timezone);
        const row = (
          await c.query<BrandRow>(
            `UPDATE brand
                SET name = COALESCE($3::text, name),
                    timezone = COALESCE($4::text, timezone),
                    timezone_set_at = CASE WHEN $4::text IS NULL THEN timezone_set_at ELSE now() END
              WHERE organization_id = $1 AND id = $2 RETURNING ${BRAND_COLUMNS}`,
            [ctx.organizationId, brandId, patch.name ?? null, patch.timezone ?? null],
          )
        ).rows[0]!;
        const audit = { organizationId: ctx.organizationId, brandId, actorUserId: ctx.actorUserId };
        const subject = { subjectType: 'brand', subjectId: brandId } as const;
        if (patch.name !== undefined) {
          await recordAudit(c, { ...audit, ...subject, action: 'brand.renamed' });
        }
        // The zone itself is not logged.
        if (patch.timezone !== undefined) {
          await recordAudit(c, {
            ...audit,
            ...subject,
            action: 'brand.updated',
            details: { timezoneChanged: true },
          });
        }
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
        await removeBrandAlerts(c, ctx.organizationId, brandId);
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
