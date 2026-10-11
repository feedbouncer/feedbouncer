export interface OrgRow {
  id: string;
  name: string;
  created_at: Date;
}

export interface OrgDto {
  id: string;
  name: string;
  createdAt: string;
}

export const ORG_COLUMNS = 'id, name, created_at';

export const toOrgDto = (r: OrgRow): OrgDto => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at.toISOString(),
});
