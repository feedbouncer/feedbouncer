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
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import {
  ConnectorError,
  toConnectorError,
  type ActionResult,
  type ConnectionClient,
  type ConnectorErrorInfo,
  type ConnectorRuntime,
  type PlatformState,
  type RespondResult,
} from '@feedbouncer/connectors';
import { JobError, type JobDefinition, type JobResult } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import {
  recordActionAudit,
  type ActionActor,
  type ActionKind,
  type ActionStatus,
} from '../actions.js';
import type { PgCommentStore } from '../store.js';
import { EXECUTE_JOB, type ExecutePayload } from './specs.js';

type Terminal = Exclude<ActionStatus, 'pending'>;

interface Final {
  readonly status: Terminal;
  readonly code: string | null;
  readonly platformRef: string | null;
  readonly undo: ActionKind | null;
  readonly commentState: PlatformState | null;
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
});
const gone = (): Final => ({ ...done('noop', 'comment_gone'), commentState: 'deleted' });

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
  return { final: done('failed', e.code) };
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
        },
      };
    }
    case 'not_found':
      return { final: gone() };
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
            : done('not_eligible', r.code),
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
 * Our reply already in the thread: written by the Page, same text, posted no
 * earlier than the action was requested. Returns its id, null when absent, or
 * the failure of the lookup itself.
 */
async function findOwnReply(
  client: ConnectionClient,
  targetExternalId: string,
  a: LoadedAction,
): Promise<string | null | { failed: ConnectorErrorInfo }> {
  try {
    const page = await client.listComments({
      sourceExternalId: targetExternalId,
      cursor: null,
      limit: OWN_REPLY_SCAN,
    });
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

async function finish(
  pool: pg.Pool,
  scope: ConnectionScope,
  a: LoadedAction,
  f: Final,
): Promise<JobResult> {
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
      return { status: cur.rows[0]?.status ?? null };
    }
    if (f.commentState !== null) {
      // Same rule as PgCommentStore.setPlatformState: never out of `deleted`.
      await tx.query(
        `UPDATE comment SET platform_state = CASE WHEN platform_state = 'deleted' THEN 'deleted' ELSE $5 END
          WHERE id = $4 AND organization_id = $1 AND brand_id = $2 AND connection_id = $3`,
        [scope.organizationId, scope.brandId, scope.connectionId, a.commentId, f.commentState],
      );
    }
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
    return { status: f.status, outcomeCode: f.code, undo: f.undo };
  });
}

export function executeActionJob(d: {
  pool: pg.Pool;
  runtime: ConnectorRuntime;
  store: PgCommentStore;
  log: Logger;
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
        // Facebook threads are one level deep: a reply to a reply goes on the top-level comment.
        const target =
          a.kind === 'public_reply' && a.parentExternalId !== null
            ? { ...commentRef, externalId: a.parentExternalId }
            : commentRef;
        const existing =
          a.kind === 'public_reply' && ctx.attempt > 1
            ? await findOwnReply(client, target.externalId, a)
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
      const result = await finish(d.pool, ctx.scope, a, outcome.final);
      d.log.info('moderation action completed', {
        actionId: a.id,
        kind: a.kind,
        status: outcome.final.status,
        outcomeCode: outcome.final.code,
      });
      if (outcome.rethrow) throw outcome.rethrow;
      return result;
    },
  };
}
