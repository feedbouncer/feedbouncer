import type { OrgStatus } from '@feedbouncer/db';

export interface OrgRow {
  id: string;
  name: string;
  timezone: string;
  timezone_set_at: Date | null;
  status: OrgStatus;
  created_at: Date;
}

export interface OrgDto {
  id: string;
  name: string;
  timezone: string;
  /** False until someone picks the zone: weekly reports then run on UTC. */
  timezoneSet: boolean;
  status: OrgStatus;
  createdAt: string;
}

export const ORG_COLUMNS = 'id, name, timezone, timezone_set_at, status, created_at';

export const toOrgDto = (r: OrgRow): OrgDto => ({
  id: r.id,
  name: r.name,
  timezone: r.timezone,
  timezoneSet: r.timezone_set_at !== null,
  status: r.status,
  createdAt: r.created_at.toISOString(),
});
