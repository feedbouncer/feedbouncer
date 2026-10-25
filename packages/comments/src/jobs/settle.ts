// Records the final outcome of a moderation action, shared by every executor
// (the per-action job and the YouTube batch dispatcher). The status update, the
// comment state and the audit record are written in one transaction, and only
// while the action is still pending.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import type { Clock, Platform, PlatformState } from '@feedbouncer/connectors';
import type { JobProducer, JobResult } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import type { ActionActor, ActionKind } from '../action-kinds.js';
import { recordActionAudit, type ActionStatus, type AuditQuota } from '../actions.js';
import { setCommentPlatformState } from '../store.js';
import type { ActionOutcomeObserver, ActionOutcomeStatus } from '../hooks.js';
import { INGEST_JOB, type IngestPayload } from './specs.js';

export type Terminal = Exclude<ActionStatus, 'pending'>;

export interface Final {
  readonly status: Terminal;
  readonly code: string | null;
  readonly platformRef: string | null;
  readonly undo: ActionKind | null;
  readonly commentState: PlatformState | null;
  /** The platform's answer means our copy of the comment may be stale: re-read it. */
  readonly resync: boolean;
}

/** What settling an action reads about it. */
export interface SettleTarget {
  readonly id: string;
  readonly commentId: string;
  readonly kind: ActionKind;
  readonly actorType: ActionActor['type'];
  readonly actorUserId: string | null;
  readonly actorApiKeyId: string | null;
  readonly ruleId: string | null;
  readonly requestKey: string;
  readonly commentExternalId: string;
  readonly sourceExternalId: string;
}

export const STATE_AFTER: Partial<Record<ActionKind, PlatformState>> = {
  hide: 'hidden',
  unhide: 'visible',
  delete: 'deleted',
};

/** `recorded` is false when another run recorded the outcome first. */
export async function settleAction(
  pool: pg.Pool,
  scope: ConnectionScope,
  a: SettleTarget,
  f: Final,
  audit: { quota?: AuditQuota } = {},
): Promise<{ result: JobResult; recorded: boolean }> {
  return withTransaction(pool, (tx) => settleActionIn(tx, scope, a, f, audit));
}

/** `settleAction` inside the caller's transaction, on its connection. */
export async function settleActionIn(
  tx: pg.ClientBase,
  scope: ConnectionScope,
  a: SettleTarget,
  f: Final,
  audit: { quota?: AuditQuota } = {},
): Promise<{ result: JobResult; recorded: boolean }> {
  const ids = [scope.organizationId, scope.brandId, scope.connectionId, a.id];
  const u = await tx.query(
    `UPDATE moderation_action
          SET status = $5, outcome_code = $6, platform_ref = $7, undo_kind = $8, completed_at = now()
        WHERE id = $4 AND organization_id = $1 AND brand_id = $2 AND connection_id = $3
          AND status = 'pending'
        RETURNING id`,
    [...ids, f.status, f.code, f.platformRef, f.undo],
  );
  if (u.rows.length === 0) {
    // Another run recorded it first.
    const cur = await tx.query<{ status: string }>(
      `SELECT status FROM moderation_action
          WHERE id = $4 AND organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
      ids,
    );
    return { result: { status: cur.rows[0]?.status ?? null }, recorded: false };
  }
  if (f.commentState !== null)
    await setCommentPlatformState(tx, scope, a.commentId, f.commentState);
  await recordActionAudit(tx, {
    organizationId: scope.organizationId,
    brandId: scope.brandId,
    actionId: a.id,
    commentId: a.commentId,
    kind: a.kind,
    actorType: a.actorType,
    actorUserId: a.actorUserId,
    actorApiKeyId: a.actorApiKeyId,
    status: f.status,
    outcomeCode: f.code,
    ...(audit.quota ? { quota: audit.quota } : {}),
  });
  return { result: { status: f.status, outcomeCode: f.code, undo: f.undo }, recorded: true };
}

/** Re-reads the comment through the ingest job. Failures are logged, never thrown. */
export async function enqueueResync(
  d: { producer: Pick<JobProducer, 'enqueue'>; log: Logger; clock: Clock },
  scope: ConnectionScope,
  platform: Platform,
  a: SettleTarget,
): Promise<void> {
  const payload: IngestPayload = {
    sourceExternalId: a.sourceExternalId,
    commentExternalId: a.commentExternalId,
    event: 'updated',
    platformEventSec: Math.floor(d.clock.now() / 1000),
    // The ingest change id is 16 hex characters; derived from the action so it is stable.
    changeId: createHash('sha256').update(`resync_${a.id}`).digest('hex').slice(0, 16),
  };
  try {
    await d.producer.enqueue({
      scope: {
        organizationId: scope.organizationId,
        brandId: scope.brandId,
        connectionId: scope.connectionId,
      },
      platform,
      type: INGEST_JOB.type,
      payload,
    });
  } catch {
    d.log.warn('moderation.resync_not_queued', { actionId: a.id });
  }
}

/** Tells the observer about an outcome. Never throws; logs the error class only (no message text). */
export async function notifyOutcome(
  d: { log: Logger; outcomes?: ActionOutcomeObserver },
  scope: ConnectionScope,
  platform: Platform,
  a: SettleTarget,
  status: ActionOutcomeStatus,
  code: string | null,
): Promise<void> {
  if (d.outcomes === undefined) return;
  try {
    await d.outcomes.onActionOutcome({
      scope: {
        organizationId: scope.organizationId,
        brandId: scope.brandId,
        connectionId: scope.connectionId,
      },
      platform,
      actionId: a.id,
      commentId: a.commentId,
      kind: a.kind,
      actorType: a.actorType,
      ruleId: a.ruleId,
      requestKey: a.requestKey,
      status,
      code,
    });
  } catch (err) {
    d.log.error('moderation.outcome_observer_failed', {
      actionId: a.id,
      errorName: err instanceof Error ? err.name : 'unknown',
    });
  }
}
