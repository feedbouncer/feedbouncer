import type { LedgerState } from '@feedbouncer/jobs';
import type { BuiltinLimit, RetentionCategory } from '../settings.js';

/**
 * One table the purge deletes from directly. Every name here is static SQL text:
 * the purge interpolates these strings and binds every value as a parameter.
 * Rows are matched as alias `x`.
 */
export interface PurgeTable {
  readonly table: string;
  /** Rows whose value here is before the category's cutoff are eligible; NULL never is. */
  readonly timeColumn: string;
  /**
   * How the purge walks the table: per brand, per organization, or once for the
   * instance. Every scoped table has organization_id, which counts are attributed to.
   */
  readonly scopeColumn: 'brand_id' | 'organization_id' | null;
  /** Further conditions every eligible row must meet. */
  readonly extraWhere?: string;
  /** Extra protection: rows are only deleted when this holds; the rest count as skipped. */
  readonly deleteOnlyIf?: string;
  /** Rows of a comment with an open review item or a pending suggestion are kept. */
  readonly protected: boolean;
  /** A built-in limit that already prunes this table; the shorter period applies. */
  readonly builtinLimit?: BuiltinLimit;
  /** Replies to a deleted comment are marked as having lost their parent first. */
  readonly detachesReplies?: true;
  /** Deleted comments are fingerprinted, so a later poll cannot ingest them again. */
  readonly fingerprints?: true;
}

/** The ledger states a job never leaves. Dead-lettered jobs can still be replayed, so they stay. */
export const FINISHED_JOB_STATES = [
  'completed',
  'resolved',
] as const satisfies readonly LedgerState[];

const noDecisionRefers = (column: string) =>
  `NOT EXISTS (SELECT 1 FROM decision d WHERE d.brand_id = x.brand_id AND d.${column} = x.id)`;

/**
 * Tables in the order they are purged. Within a category, a row is only deleted
 * once nothing newer that would cascade with it is left, so a cascade never takes
 * a row that is still inside its own period.
 */
export const PURGE_TABLES: Readonly<Record<RetentionCategory, readonly PurgeTable[]>> = {
  previews: [
    {
      table: 'policy_preview',
      timeColumn: 'created_at',
      scopeColumn: 'brand_id',
      protected: false,
      builtinLimit: 'previews',
    },
  ],
  operational: [
    {
      table: 'job_ledger',
      timeColumn: 'created_at',
      scopeColumn: 'brand_id',
      extraWhere: `x.state IN (${FINISHED_JOB_STATES.map((s) => `'${s}'`).join(', ')})`,
      protected: false,
    },
    {
      table: 'webhook_event',
      timeColumn: 'created_at',
      scopeColumn: 'organization_id',
      extraWhere: `NOT EXISTS (SELECT 1 FROM webhook_delivery w WHERE w.event_id = x.id
                     AND w.status IN ('pending', 'sending', 'retrying'))`,
      protected: false,
      builtinLimit: 'webhookEvents',
    },
    {
      table: 'alert_event',
      timeColumn: 'created_at',
      scopeColumn: 'organization_id',
      extraWhere: `NOT EXISTS (SELECT 1 FROM alert_delivery a WHERE a.alert_event_id = x.id
                     AND a.state IN ('pending', 'sending', 'retrying'))`,
      protected: false,
    },
    {
      table: 'api_idempotency_record',
      timeColumn: 'created_at',
      scopeColumn: 'organization_id',
      protected: false,
      builtinLimit: 'idempotencyRecords',
    },
  ],
  decisions: [
    { table: 'decision', timeColumn: 'created_at', scopeColumn: 'brand_id', protected: true },
    { table: 'action_run', timeColumn: 'created_at', scopeColumn: 'brand_id', protected: true },
    {
      table: 'policy_evaluation',
      timeColumn: 'created_at',
      scopeColumn: 'brand_id',
      // decision.policy_evaluation_id has no ON DELETE action, so a referenced row cannot go.
      extraWhere: noDecisionRefers('policy_evaluation_id'),
      protected: true,
    },
    {
      table: 'comment_classification',
      timeColumn: 'created_at',
      scopeColumn: 'brand_id',
      extraWhere: noDecisionRefers('classification_id'),
      protected: true,
    },
    {
      table: 'rule_evaluation',
      timeColumn: 'created_at',
      scopeColumn: 'brand_id',
      extraWhere: `${noDecisionRefers('rule_evaluation_id')}
        AND NOT EXISTS (SELECT 1 FROM comment_classification k WHERE k.rule_evaluation_id = x.id)
        AND NOT EXISTS (SELECT 1 FROM policy_evaluation p WHERE p.rule_evaluation_id = x.id)
        AND NOT EXISTS (SELECT 1 FROM action_run r WHERE r.rule_evaluation_id = x.id)`,
      protected: true,
    },
    {
      table: 'action_suggestion',
      timeColumn: 'created_at',
      scopeColumn: 'brand_id',
      extraWhere: `x.status <> 'pending'
        AND NOT EXISTS (SELECT 1 FROM action_run r WHERE r.suggestion_id = x.id)`,
      protected: true,
    },
    {
      table: 'moderation_action',
      timeColumn: 'completed_at',
      scopeColumn: 'brand_id',
      protected: true,
    },
    {
      table: 'review_item',
      timeColumn: 'resolved_at',
      scopeColumn: 'brand_id',
      extraWhere: `x.status = 'resolved'`,
      protected: true,
    },
  ],
  comments: [
    {
      table: 'comment',
      timeColumn: 'ingested_at',
      scopeColumn: 'brand_id',
      // An action still being carried out on the platform keeps its comment.
      extraWhere: `NOT EXISTS (SELECT 1 FROM moderation_action m WHERE m.brand_id = x.brand_id
                     AND m.comment_id = x.id AND m.completed_at IS NULL)`,
      // Deleting a comment cascades to its webhook events and alert flag items, so a
      // delivery still in flight for either keeps the comment, as it keeps the event itself.
      // Counted as skipped, like a comment waiting in the review queue.
      deleteOnlyIf: `NOT EXISTS (SELECT 1 FROM webhook_event e
                         JOIN webhook_delivery w ON w.event_id = e.id
                        WHERE e.brand_id = x.brand_id AND e.comment_id = x.id
                          AND w.status IN ('pending', 'sending', 'retrying'))
        AND NOT EXISTS (SELECT 1 FROM alert_flag_item f
                         JOIN alert_delivery a ON a.alert_event_id = f.alert_event_id
                        WHERE f.brand_id = x.brand_id AND f.comment_id = x.id
                          AND a.state IN ('pending', 'sending', 'retrying'))`,
      protected: true,
      detachesReplies: true,
      fingerprints: true,
    },
    {
      table: 'author',
      timeColumn: 'updated_at',
      scopeColumn: 'brand_id',
      extraWhere: `NOT EXISTS (SELECT 1 FROM comment c WHERE c.connection_id = x.connection_id
                     AND c.author_id = x.id)`,
      protected: false,
    },
  ],
  audit: [
    {
      table: 'audit_event',
      timeColumn: 'created_at',
      scopeColumn: 'organization_id',
      protected: false,
    },
    {
      table: 'privacy_request',
      timeColumn: 'finished_at',
      scopeColumn: 'organization_id',
      // A request whose export can still be downloaded is kept until the export expires.
      extraWhere: 'x.export_expires_at IS NULL',
      protected: false,
    },
    { table: 'retention_run', timeColumn: 'finished_at', scopeColumn: null, protected: false },
  ],
};

/** The order categories are purged in. */
export const PURGE_ORDER: readonly RetentionCategory[] = [
  'previews',
  'operational',
  'decisions',
  'comments',
  'audit',
];

/** True when the row's comment is not waiting in the review queue. */
export const notPendingReview = (t: PurgeTable): string => {
  const key = t.table === 'comment' ? 'x.id' : 'x.comment_id';
  return `NOT EXISTS (SELECT 1 FROM review_item r WHERE r.comment_id = ${key} AND r.status = 'open')
      AND NOT EXISTS (SELECT 1 FROM action_suggestion s WHERE s.comment_id = ${key} AND s.status = 'pending')`;
};
