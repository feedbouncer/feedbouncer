// Executes one pending moderation action on the platform and records the
// outcome. Safe to repeat:
// - an action that is no longer pending is returned as it is (a crash after
//   the outcome was recorded);
// - a public reply retried after an earlier attempt may already be posted, so
//   from the second attempt on the thread is checked for our reply first;
// - a private reply the platform reports as already sent on a retry is our
//   own earlier attempt.
// The status update, the comment state and the audit record are written in
// one transaction, and only while the action is still pending.
// When the platform's answer shows our stored copy is out of date (the comment
// is gone, a reply was refused, a permanent error), the comment is re-read by
// enqueueing an ingest job: owners can hide or delete in the platform's own app
// without any webhook. That enqueue is best-effort and never changes the
// recorded outcome.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import {
  ConnectorError,
  toConnectorError,
  type ActionResult,
  type Clock,
  type CommentRef,
  type ConnectionClient,
  type ConnectorErrorInfo,
  type ConnectorRuntime,
  type Platform,
  type PlatformState,
  type RespondResult,
} from '@feedbouncer/connectors';
import { JobError, type JobDefinition, type JobProducer, type JobResult } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import { AUTHOR_KINDS, type ActionActor, type ActionKind } from '../action-kinds.js';
import { recordActionAudit, type ActionStatus } from '../actions.js';
import { setCommentPlatformState } from '../store.js';
import { EXECUTE_JOB, INGEST_JOB, type ExecutePayload, type IngestPayload } from './specs.js';

type Terminal = Exclude<ActionStatus, 'pending'>;

interface Final {
  readonly status: Terminal;
  readonly code: string | null;
  readonly platformRef: string | null;
  readonly undo: ActionKind | null;
  readonly commentState: PlatformState | null;
  /** The platform's answer means our copy of the comment may be stale: re-read it. */
  readonly resync: boolean;
}

interface LoadedAction {
  readonly id: string;
  readonly commentId: string;
  readonly kind: ActionKind;
  readonly actorType: ActionActor['type'];
  readonly actorUserId: string | null;
  readonly status: ActionStatus;
  readonly replyText: string | null;
  readonly createdAt: Date;
  readonly commentExternalId: string;
  readonly parentExternalId: string | null;
  readonly sourceExternalId: string;
  readonly authorExternalId: string | null;
  readonly pageExternalId: string;
}

/** Thrown for these so the job framework retries, defers or dead-letters as needs_reconnection. */
const RETRY_KINDS: ReadonlySet<string> = new Set(['rate_limited', 'transient', 'auth_expired']);
/** Failure codes that mean the action cannot apply to this author, not that it failed. */
const NOT_ELIGIBLE_CODES: ReadonlySet<string> = new Set([
  'author_is_page',
  'author_unavailable',
  'author_not_bannable',
  'ban_limit_reached',
  'reblock_too_soon',
]);
const UNDO_KINDS: ReadonlySet<string> = new Set(['hide', 'unhide', 'ban_author', 'unban_author']);
const STATE_AFTER: Partial<Record<ActionKind, PlatformState>> = {
  hide: 'hidden',
  unhide: 'visible',
  delete: 'deleted',
};
/** Allowance for clock skew between our database and the platform. */
const OWN_REPLY_SKEW_MS = 60_000;
const OWN_REPLY_SCAN = 25;

const done = (status: Terminal, code: string | null = null): Final => ({
  status,
  code,
  platformRef: null,
  undo: null,
  commentState: null,
  resync: false,
});
const gone = (): Final => ({
  ...done('noop', 'comment_gone'),
  commentState: 'deleted',
  resync: true,
});

/** A failed platform call: a final outcome, or an error to rethrow (after recording `final`, if set). */
type FailureOutcome = { final: Final; rethrow?: ConnectorError } | { rethrow: ConnectorError };

function mapFailure(e: ConnectorErrorInfo, attempt: number): FailureOutcome {
  if (NOT_ELIGIBLE_CODES.has(e.code)) return { final: done('not_eligible', e.code) };
  // A revoked connection cannot be fixed by retrying or re-authorizing.
  if (e.kind === 'auth_expired' && !e.reauthorize) return { final: done('failed', e.code) };
  if (RETRY_KINDS.has(e.kind)) {
    const rethrow = new ConnectorError(e.kind, e.code, {
      ...(e.retryAfterMs !== null ? { retryAfterMs: e.retryAfterMs } : {}),
      reauthorize: e.reauthorize,
    });
    // The last attempt: record the failure so the action does not stay pending forever.
    if (e.kind === 'transient' && attempt >= EXECUTE_JOB.policy.maxAttempts)
      return { final: done('failed', e.code), rethrow };
    return { rethrow };
  }
  return { final: { ...done('failed', e.code), resync: e.kind === 'permanent' } };
}

function mapAct(r: ActionResult, kind: ActionKind, attempt: number): FailureOutcome {
  switch (r.status) {
    case 'applied': {
      const undo = r.undo?.action;
      return {
        final: {
          status: 'applied',
          code: null,
          platformRef: r.platformActionId,
          undo: undo !== undefined && UNDO_KINDS.has(undo) ? (undo as ActionKind) : null,
          commentState: STATE_AFTER[kind] ?? null,
          resync: false,
        },
      };
    }
    case 'not_found':
      // A ban targets the author: a missing author says nothing about the comment.
      return { final: AUTHOR_KINDS.has(kind) ? done('failed', 'not_found') : gone() };
    case 'unsupported':
      return { final: done('failed', 'unsupported') };
    case 'failed':
      return mapFailure(r.error, attempt);
  }
}

function mapRespond(r: RespondResult, attempt: number): FailureOutcome {
  switch (r.status) {
    case 'sent':
      return { final: { ...done('applied'), platformRef: r.platformRef } };
    case 'not_found':
      return { final: gone() };
    case 'not_eligible':
      // On a retry, "already sent" is our own earlier attempt that succeeded.
      return {
        final:
          r.code === 'private_reply_already_sent' && attempt > 1
            ? done('applied')
            : { ...done('not_eligible', r.code), resync: true },
      };
    case 'unsupported':
      return { final: done('failed', 'unsupported') };
    case 'failed':
      return mapFailure(r.error, attempt);
  }
}

async function loadForExecution(
  pool: pg.Pool,
  scope: ConnectionScope,
  actionId: string,
): Promise<LoadedAction | null> {
  const r = await pool.query(
    `SELECT m.id, m.comment_id, m.kind, m.actor_type, m.actor_user_id, m.status, m.reply_text,
            m.created_at, c.external_id AS comment_external_id, c.parent_external_id,
            s.external_id AS source_external_id, a.external_id AS author_external_id,
            cn.external_account_id
       FROM moderation_action m
       JOIN comment c ON c.id = m.comment_id AND c.organization_id = m.organization_id
                     AND c.brand_id = m.brand_id AND c.connection_id = m.connection_id
       JOIN source s ON s.id = c.source_id AND s.organization_id = m.organization_id
                    AND s.brand_id = m.brand_id
       JOIN connection cn ON cn.id = m.connection_id AND cn.organization_id = m.organization_id
                         AND cn.brand_id = m.brand_id
       LEFT JOIN author a ON a.id = c.author_id AND a.connection_id = c.connection_id
      WHERE m.id = $4 AND m.organization_id = $1 AND m.brand_id = $2 AND m.connection_id = $3`,
    [scope.organizationId, scope.brandId, scope.connectionId, actionId],
  );
  const x = r.rows[0] as Record<string, unknown> | undefined;
  if (!x) return null;
  return {
    id: x.id as string,
    commentId: x.comment_id as string,
    kind: x.kind as ActionKind,
    actorType: x.actor_type as ActionActor['type'],
    actorUserId: (x.actor_user_id as string | null) ?? null,
    status: x.status as ActionStatus,
    replyText: (x.reply_text as string | null) ?? null,
    createdAt: x.created_at as Date,
    commentExternalId: x.comment_external_id as string,
    parentExternalId: (x.parent_external_id as string | null) ?? null,
    sourceExternalId: x.source_external_id as string,
    authorExternalId: (x.author_external_id as string | null) ?? null,
    pageExternalId: x.external_account_id as string,
  };
}

/**
 * Our reply already in the thread: written by the connected account, same
 * text, posted no earlier than the action was requested. Returns its id, null
 * when absent, or the failure of the lookup itself. Connectors with a replies
 * listing (Instagram) are asked for the replies under the comment; otherwise
 * the comment is listed as a source (Facebook).
 */
async function findOwnReply(
  client: ConnectionClient,
  target: CommentRef,
  a: LoadedAction,
): Promise<string | null | { failed: ConnectorErrorInfo }> {
  try {
    const page =
      (await client.listReplies({ parent: target, cursor: null, limit: OWN_REPLY_SCAN })) ??
      (await client.listComments({
        sourceExternalId: target.externalId,
        cursor: null,
        limit: OWN_REPLY_SCAN,
      }));
    const since = a.createdAt.getTime() - OWN_REPLY_SKEW_MS;
    const hit = page.items.find(
      (c) =>
        c.author?.externalId === a.pageExternalId &&
        c.body === a.replyText &&
        c.postedAt.getTime() >= since,
    );
    return hit?.externalId ?? null;
  } catch (err) {
    const ce = toConnectorError(err);
    // The thread is gone: the reply call below reports it.
    if (ce.kind === 'not_found' && ce.code !== 'connection_not_found') return null;
    return { failed: ce.info() };
  }
}

/** `recorded` is false when another run recorded the outcome first. */
async function finish(
  pool: pg.Pool,
  scope: ConnectionScope,
  a: LoadedAction,
  f: Final,
): Promise<{ result: JobResult; recorded: boolean }> {
  return withTransaction(pool, async (tx) => {
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
      status: f.status,
      outcomeCode: f.code,
    });
    return { result: { status: f.status, outcomeCode: f.code, undo: f.undo }, recorded: true };
  });
}

/** Re-reads the comment through the ingest job. Failures are logged, never thrown. */
async function enqueueResync(
  d: { producer: Pick<JobProducer, 'enqueue'>; log: Logger; clock: Clock },
  scope: ConnectionScope,
  platform: Platform,
  a: LoadedAction,
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

export function executeActionJob(d: {
  pool: pg.Pool;
  runtime: ConnectorRuntime;
  log: Logger;
  /** Enqueues the resync ingest after outcomes the platform decided. */
  producer: Pick<JobProducer, 'enqueue'>;
  clock: Clock;
}): JobDefinition<ExecutePayload> {
  return {
    ...EXECUTE_JOB,
    handle: async (ctx, { actionId }) => {
      const a = await loadForExecution(d.pool, ctx.scope, actionId);
      if (!a) throw new JobError('non_retryable', 'action_not_found');
      if (a.status !== 'pending') return { status: a.status };

      const client = await d.runtime.connect(ctx.scope);
      const commentRef = { sourceExternalId: a.sourceExternalId, externalId: a.commentExternalId };
      let outcome: FailureOutcome;
      if (a.kind === 'public_reply' || a.kind === 'private_reply') {
        if (a.replyText === null) throw new JobError('non_retryable', 'reply_text_missing');
        // Facebook and Instagram threads are one level deep; replies to a reply go on the top-level comment.
        const target =
          a.kind === 'public_reply' && a.parentExternalId !== null
            ? { ...commentRef, externalId: a.parentExternalId }
            : commentRef;
        const existing =
          a.kind === 'public_reply' && ctx.attempt > 1
            ? await findOwnReply(client, target, a)
            : null;
        if (typeof existing === 'string') {
          outcome = { final: { ...done('applied'), platformRef: existing } };
        } else if (existing !== null) {
          outcome = mapFailure(existing.failed, ctx.attempt);
        } else {
          const r = await client.respond({ kind: a.kind, target, text: a.replyText });
          outcome = mapRespond(r, ctx.attempt);
        }
      } else {
        const r = await client.act({
          action: a.kind,
          target: commentRef,
          ...(a.authorExternalId !== null ? { authorExternalId: a.authorExternalId } : {}),
        });
        outcome = mapAct(r, a.kind, ctx.attempt);
      }

      if (!('final' in outcome)) throw outcome.rethrow;
      const { result, recorded } = await finish(d.pool, ctx.scope, a, outcome.final);
      d.log.info('moderation action completed', {
        actionId: a.id,
        kind: a.kind,
        status: outcome.final.status,
        outcomeCode: outcome.final.code,
      });
      if (recorded && outcome.final.resync) await enqueueResync(d, ctx.scope, ctx.platform, a);
      if (outcome.rethrow) throw outcome.rethrow;
      return result;
    },
  };
}
