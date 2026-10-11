export interface BrandRow {
  id: string;
  organization_id: string;
  name: string;
  archived_at: Date | null;
  created_at: Date;
}

export interface BrandDto {
  id: string;
  organizationId: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
}

export const BRAND_COLUMNS = 'id, organization_id, name, archived_at, created_at';

export const toBrandDto = (r: BrandRow): BrandDto => ({
  id: r.id,
  organizationId: r.organization_id,
  name: r.name,
  archivedAt: r.archived_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});
