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
  | 'invitation.created'
  | 'invitation.renewed'
  | 'invitation.revoked'
  /** Also records joining: details.joined is false when the user was already a member. */
  | 'invitation.accepted'
  | 'rule.created'
  | 'rule.updated'
  | 'rule.archived'
  | 'rule.reordered'
  | 'action_step.undone'
  | 'review_item.resolved'
  | 'brand_domain.added'
  | 'brand_domain.removed'
  | 'classifier_threshold.updated'
  | 'classifier_threshold.reset'
  | 'classifier.rerun_requested'
  | 'policy.created'
  | 'policy.revised'
  | 'policy.renamed'
  | 'policy.enabled'
  | 'policy.disabled'
  | 'policy.archived'
  | 'policy.preview_requested'
  | 'policy.run_requested';

export interface AuditInput {
  organizationId: string;
  brandId?: string | null;
  actorUserId: string;
  action: AuditAction;
  subjectType:
    | 'organization'
    | 'brand'
    | 'membership'
    | 'invitation'
    | 'rule'
    | 'brand_domain'
    | 'classifier_threshold'
    | 'classifier_run'
    | 'custom_policy'
    | 'policy_preview'
    | 'policy_run';
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
