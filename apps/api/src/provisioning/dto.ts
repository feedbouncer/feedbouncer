import type { Role } from '@feedbouncer/authz';
import { orgApiStatus, userApiStatus, type ApiStatus } from './status.js';

export interface ProvisionedOrganization {
  id: string;
  externalRef: string | null;
  name: string;
  status: ApiStatus;
  createdAt: string;
}

export interface ProvisionedMembership {
  organizationId: string;
  role: Role;
  organizationStatus: ApiStatus;
}

export interface ProvisionedUser {
  id: string;
  externalRef: string | null;
  email: string;
  name: string | null;
  status: ApiStatus;
  memberships: ProvisionedMembership[];
  createdAt: string;
}

export interface OrganizationRow {
  id: string;
  external_ref: string | null;
  name: string;
  status: string;
  created_at: Date;
}

export interface UserRow {
  id: string;
  external_ref: string | null;
  email: string;
  display_name: string | null;
  status: string;
  created_at: Date;
}

export interface MembershipRow {
  organization_id: string;
  role: Role;
  organization_status: string;
}

export const ORGANIZATION_COLUMNS = 'id, external_ref, name, status, created_at';
export const USER_COLUMNS = 'id, external_ref, email, display_name, status, created_at';

export const toProvisionedOrganization = (r: OrganizationRow): ProvisionedOrganization => ({
  id: r.id,
  externalRef: r.external_ref,
  name: r.name,
  status: orgApiStatus(r.status),
  createdAt: r.created_at.toISOString(),
});

export const toProvisionedUser = (r: UserRow, memberships: MembershipRow[]): ProvisionedUser => ({
  id: r.id,
  externalRef: r.external_ref,
  email: r.email,
  name: r.display_name,
  status: userApiStatus(r.status),
  memberships: memberships.map((m) => ({
    organizationId: m.organization_id,
    role: m.role,
    organizationStatus: orgApiStatus(m.organization_status),
  })),
  createdAt: r.created_at.toISOString(),
});
