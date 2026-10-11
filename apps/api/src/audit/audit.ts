import type pg from 'pg';

export type AuditAction =
  | 'organization.created'
  | 'organization.renamed'
  | 'organization.ownership_transferred'
  | 'brand.created'
  | 'brand.renamed'
  | 'brand.archived'
  | 'membership.role_changed'
  | 'membership.removed'
  | 'membership.left'
  | 'membership.joined'
  | 'invitation.created'
  | 'invitation.renewed'
  | 'invitation.revoked'
  | 'invitation.accepted';

export interface AuditInput {
  organizationId: string;
  brandId?: string | null;
  actorUserId: string;
  action: AuditAction;
  subjectType: 'organization' | 'brand' | 'membership' | 'invitation';
  subjectId: string | null;
  /** Ids, roles and booleans only: never emails, people's names or tokens. */
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Writes inside the caller's transaction, so the event commits or rolls back with the change. */
export async function recordAudit(c: pg.PoolClient, e: AuditInput): Promise<void> {
  await c.query(
    `INSERT INTO audit_event (organization_id, brand_id, actor_type, actor_user_id, action, subject_type, subject_id, details)
     VALUES ($1, $2, 'user', $3, $4, $5, $6, $7::jsonb)`,
    [
      e.organizationId,
      e.brandId ?? null,
      e.actorUserId,
      e.action,
      e.subjectType,
      e.subjectId,
      JSON.stringify(e.details ?? {}),
    ],
  );
}
