import type pg from 'pg';
import { recordAudit as writeAudit } from '@feedbouncer/actions';

export type AuditAction =
  | 'organization.created'
  | 'organization.renamed'
  | 'organization.ownership_transferred'
  | 'brand.created'
  | 'brand.renamed'
  | 'brand.updated'
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
  | 'policy.run_requested'
  | 'review_mode.opted_out'
  | 'review_mode.ended_early'
  | 'suggestion.approved'
  | 'suggestion.dismissed'
  | 'suggestion.bulk_requested';

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
    | 'action_run_step'
    | 'review_item'
    | 'brand_domain'
    | 'classifier_threshold'
    | 'classifier_run'
    | 'custom_policy'
    | 'policy_preview'
    | 'policy_run'
    | 'connection'
    | 'action_suggestion';
  subjectId: string | null;
  /** Ids, roles and booleans only: never emails, people's names or tokens. */
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export const recordAudit: (c: pg.PoolClient, e: AuditInput) => Promise<void> = writeAudit;
