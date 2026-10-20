import type pg from 'pg';
import { notFound } from '../http/errors.js';
import { parseUuidOr404 } from '../http/validation.js';
import type { OrgContext } from './org-access.guard.js';

export interface BrandScope {
  readonly organizationId: string;
  readonly brandId: string;
}

/**
 * The path brand, which must be a live brand of the path organization: a
 * brand of another organization (or an archived one) is a plain 404.
 */
export async function requireBrand(
  pool: pg.Pool,
  org: Pick<OrgContext, 'organizationId'>,
  rawBrandId: unknown,
): Promise<BrandScope> {
  const brandId = parseUuidOr404(rawBrandId);
  const r = await pool.query(
    'SELECT 1 FROM brand WHERE id = $2 AND organization_id = $1 AND archived_at IS NULL',
    [org.organizationId, brandId],
  );
  if (r.rowCount === 0) throw notFound();
  return { organizationId: org.organizationId, brandId };
}

/** The organization's only live brand, or null when it has none or several. */
export async function soleActiveBrand(
  pool: pg.Pool,
  organizationId: string,
): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    'SELECT id FROM brand WHERE organization_id = $1 AND archived_at IS NULL LIMIT 2',
    [organizationId],
  );
  return r.rows.length === 1 ? r.rows[0]!.id : null;
}
