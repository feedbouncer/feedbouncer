export interface BrandRow {
  id: string;
  organization_id: string;
  name: string;
  archived_at: Date | null;
  created_at: Date;
  timezone: string;
  timezone_set_at: Date | null;
}

export interface BrandDto {
  id: string;
  organizationId: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  /** The IANA zone whose midnight starts "today" for this brand. */
  timezone: string;
  /** False while the brand still has the UTC default nobody chose. */
  timezoneSet: boolean;
}

export const BRAND_COLUMNS =
  'id, organization_id, name, archived_at, created_at, timezone, timezone_set_at';

export const toBrandDto = (r: BrandRow): BrandDto => ({
  id: r.id,
  organizationId: r.organization_id,
  name: r.name,
  archivedAt: r.archived_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  timezone: r.timezone,
  timezoneSet: r.timezone_set_at !== null,
});
