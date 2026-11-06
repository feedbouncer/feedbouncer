import type pg from 'pg';
import { recordAuditEvent } from './audit.js';
import type { OrgStatus } from './org-status.js';

export const SUSPENSION_REASONS = ['abuse', 'non_payment', 'customer_request', 'other'] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

export interface OrganizationStatusChange {
  organizationId: string;
  to: OrgStatus;
  reason: SuspensionReason;
  via: 'ops_cli' | 'provisioning_api';
  actorUserId: string | null;
}

/**
 * Sets an organization's status inside the caller's transaction, locking the row
 * first (FOR UPDATE, which waits for a create-user's FOR SHARE). A real change
 * writes organization.suspended or organization.reactivated; a no-op writes
 * nothing. Null when the organization does not exist.
 */
export async function changeOrganizationStatus(
  tx: pg.ClientBase,
  c: OrganizationStatusChange,
): Promise<{ from: OrgStatus; to: OrgStatus; changed: boolean } | null> {
  const row = (
    await tx.query<{ status: OrgStatus }>(
      'SELECT status FROM organization WHERE id = $1 FOR UPDATE',
      [c.organizationId],
    )
  ).rows[0];
  if (!row) return null;
  const { status: from } = row;
  if (from === c.to) return { from, to: c.to, changed: false };
  await tx.query('UPDATE organization SET status = $2 WHERE id = $1', [c.organizationId, c.to]);
  await recordAuditEvent(tx, {
    organizationId: c.organizationId,
    actorType: 'system',
    actorUserId: c.actorUserId,
    action: c.to === 'suspended' ? 'organization.suspended' : 'organization.reactivated',
    subjectType: 'organization',
    subjectId: c.organizationId,
    details: { from, to: c.to, reason: c.reason, via: c.via },
  });
  return { from, to: c.to, changed: true };
}
