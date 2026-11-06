import type pg from 'pg';

export interface ProvisioningAuditDetails {
  errorCode?: string;
  fields?: string;
  organizationId?: string;
  role?: 'owner' | 'admin' | 'member';
}

export interface ProvisioningAuditInput {
  action:
    | 'organization.create'
    | 'organization.read'
    | 'organization.set_status'
    | 'user.create'
    | 'user.read'
    | 'user.set_status';
  targetType: 'organization' | 'user';
  targetId: string | null;
  outcome:
    | 'created'
    | 'replayed'
    | 'read'
    | 'changed'
    | 'unchanged'
    | 'not_found'
    | 'conflict'
    | 'invalid'
    | 'failed';
  credentialFingerprint: string;
  details?: ProvisioningAuditDetails;
}

export async function recordProvisioningAudit(
  c: Pick<pg.ClientBase, 'query'>,
  e: ProvisioningAuditInput,
): Promise<void> {
  await c.query(
    `INSERT INTO provisioning_audit_event (credential_fingerprint, action, target_type, target_id, outcome, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      e.credentialFingerprint,
      e.action,
      e.targetType,
      e.targetId,
      e.outcome,
      JSON.stringify(e.details ?? {}),
    ],
  );
}
