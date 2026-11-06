import { ROLES, type Role } from '@feedbouncer/authz';
import { SUSPENSION_REASONS } from '@feedbouncer/db';
import { normalizeAddress } from '@feedbouncer/mailer';
import { z } from 'zod';
import { zName } from '../http/validation.js';
import { orgApiStatus, userApiStatus, type ApiStatus } from './status.js';

/** The caller's own id for an account; the key of idempotent creates. */
export const zExternalRef = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/);

/** Trimmed and lowercased, as stored in app_user.email. */
const zEmail = z
  .string()
  .max(254)
  .transform((raw, ctx) => {
    const email = normalizeAddress(raw);
    if (email === null) ctx.addIssue({ code: 'custom', message: 'invalid' });
    return email ?? z.NEVER;
  });

export const CreateOrganizationBody = z.strictObject({ externalRef: zExternalRef, name: zName });
export type CreateOrganizationInput = z.infer<typeof CreateOrganizationBody>;

export const CreateUserBody = z.strictObject({
  externalRef: zExternalRef,
  email: zEmail,
  name: zName,
  role: z.enum(ROLES),
  allowInactiveOrganization: z.boolean().optional(),
  sendSetupEmail: z.boolean().optional(),
});
export type CreateUserInput = z.infer<typeof CreateUserBody>;

export const SetStatusBody = z.strictObject({
  status: z.enum(['active', 'inactive']),
  reason: z.enum(SUSPENSION_REASONS).optional(),
});
export type SetStatusInput = z.infer<typeof SetStatusBody>;

export type SetupEmail = 'sent' | 'skipped' | 'failed';

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
