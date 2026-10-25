// Sends one cycle's planned YouTube write batches. Every batch is first written
// down (`youtube_write_batch`, state `planned`) in the same transaction that
// claims its queue rows, then probed (1 unit), marked `sent`, and written (one
// 50-unit setModerationStatus call). A crash leaves the batch `planned` or
// `sent` with its rows in flight; `recoverInFlight` requeues a planned batch and
// settles a sent one from a fresh probe, never by sending it again, so a write
// is neither applied nor counted twice.
// Dry-run plans against the simulated allowance: no probe and no write, one
// simulated 51-unit ledger row per batch, and each action settles noop/dry_run.
// Audit details carry quota numbers only, and logs carry ids and codes only:
// never a comment body or a token.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from '@feedbouncer/db';
import {
  ConnectorError,
  isQuotaRefusal,
  QUOTA_REFUSAL_CODES,
  type Clock,
  type CommentProbe,
  type CommentRef,
  type ConnectionClient,
  type ConnectorErrorInfo,
} from '@feedbouncer/connectors';
import { BATCH_UNITS } from '@feedbouncer/connector-youtube';
import type { JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import type { ActionKind } from '../action-kinds.js';
import type { AuditQuota } from '../actions.js';
import type { ActionOutcomeObserver } from '../hooks.js';
import {
  enqueueResync,
  notifyOutcome,
  settleActionIn,
  STATE_AFTER,
  type Final,
} from '../jobs/settle.js';
import type { PgYouTubeBacklog, QueuedTarget } from './backlog.js';
import { budgetView } from './budget.js';
import type { PgYouTubeQuotaLedger } from './ledger.js';
import type { CyclePlan, PlannedBatch, SettleNow } from './planner.js';
import { pacificDayKey } from './quota-day.js';
import { SCOPED, scopeParams, type Queryable } from './sql.js';

/** The cycle lease: a planned or sent batch older than this belongs to a run that died. */
export const CYCLE_LEASE_MS = 600_000;
/** Settled batches (opaque ids only) are kept this many Pacific days, then deleted. */
const WRITE_BATCH_RETENTION_DAYS = 2;

const WRITE_METHOD = 'comments.setModerationStatus';
const PROBE_UNITS = 1;
const WRITE_UNITS = BATCH_UNITS - PROBE_UNITS;

export interface DispatchDeps {
  pool: pg.Pool;
  client: Pick<ConnectionClient, 'actBatch' | 'probeComments'>;
  backlog: PgYouTubeBacklog;
  ledger: PgYouTubeQuotaLedger;
  /** Enqueues the re-ingest of a comment edited since we read it. */
  producer: Pick<JobProducer, 'enqueue'>;
  outcomes?: ActionOutcomeObserver;
  log: Logger;
  clock: Clock;
}

export type StopReason = 'quota_exceeded' | 'budget' | 'auth' | 'transient';

export interface DispatchResult {
  /** Batches whose write reached YouTube (the quota counts them, whatever the answer). */
  batchesSent: number;
  /** Real units reserved in the ledger by this dispatch (0 in dry-run). */
  unitsSpent: number;
  /** Why the cycle stopped early. Transient failures are rethrown so the job retries with backoff. */
  stoppedBy: null | StopReason;
}

interface Entry {
  readonly t: QueuedTarget;
  readonly f: Final;
  readonly quota?: AuditQuota;
}

interface Acc {
  batchesSent: number;
  unitsSpent: number;
}

const final = (
  status: Final['status'],
  code: string | null,
  o: Partial<Pick<Final, 'undo' | 'commentState' | 'resync'>> = {},
): Final => ({
  status,
  code,
  platformRef: null,
  undo: o.undo ?? null,
  commentState: o.commentState ?? null,
  resync: o.resync ?? false,
});

const UNDO: Partial<Record<ActionKind, ActionKind>> = { hide: 'unhide', unhide: 'hide' };

/** A YouTube reject (with or without a ban) removes the comment from view. */
const stateAfter = (kind: ActionKind) =>
  STATE_AFTER[kind] ?? (kind === 'ban_author' ? 'deleted' : null);

const applied = (t: QueuedTarget, code: string | null): Final =>
  final('applied', code, { undo: UNDO[t.kind] ?? null, commentState: stateAfter(t.kind) });

/** A reject folded into a ban batch. */
const isFolded = (t: QueuedTarget, banAuthor: boolean) => banAuthor && t.kind === 'delete';

/** One ref per comment: two actions on one comment share it. */
function refsOf(items: readonly QueuedTarget[]): CommentRef[] {
  const seen = new Map<string, CommentRef>();
  for (const t of items)
    if (!seen.has(t.commentExternalId))
      seen.set(t.commentExternalId, {
        sourceExternalId: t.sourceExternalId,
        externalId: t.commentExternalId,
      });
  return [...seen.values()];
}

/**
 * Settles each entry and drops it from the queue, applies `batch` (and requeues
 * `requeue`) in the same transaction, then notifies and resyncs what this call
 * recorded.
 */
async function commit(
  d: DispatchDeps,
  scope: ConnectionScope,
  entries: readonly Entry[],
  o: {
    batch?: { id: string; state: 'confirmed' | 'failed'; code: string | null };
    requeue?: readonly string[];
  } = {},
): Promise<void> {
  const recorded = await withTransaction(d.pool, async (tx) => {
    const out: Entry[] = [];
    for (const e of entries) {
      const s = await settleActionIn(tx, scope, e.t, e.f, e.quota ? { quota: e.quota } : {});
      if (s.recorded) out.push(e);
    }
    if (entries.length > 0)
      await d.backlog.remove(
        tx,
        scope,
        entries.map((e) => e.t.id),
      );
    if (o.requeue && o.requeue.length > 0) await d.backlog.requeue(scope, o.requeue, tx);
    if (o.batch) await finishBatch(tx, d.clock, scope, o.batch);
    return out;
  });
  for (const e of recorded) {
    await notifyOutcome(d, scope, 'youtube', e.t, e.f.status, e.f.code);
    if (e.f.resync) await enqueueResync(d, scope, 'youtube', e.t);
  }
}

async function finishBatch(
  q: Queryable,
  clock: Clock,
  scope: ConnectionScope,
  b: { id: string; state: 'confirmed' | 'failed'; code: string | null },
): Promise<void> {
  await q.query(
    `UPDATE youtube_write_batch SET state = $5, outcome_code = $6, completed_at = $7
      WHERE ${SCOPED} AND id = $4`,
    [...scopeParams(scope), b.id, b.state, b.code, new Date(clock.now())],
  );
}

/** Settles the planner's call-free outcomes at zero cost. */
async function settleNow(
  d: DispatchDeps,
  scope: ConnectionScope,
  items: readonly SettleNow[],
): Promise<void> {
  if (items.length === 0) return;
  const byId = new Map(items.map((s) => [s.actionId, s]));
  const targets = await d.backlog.targets(d.pool, scope, [...byId.keys()]);
  const entries = targets.map((t) => {
    const s = byId.get(t.id)!;
    if (s.code === 'author_protected' || s.code === 'author_unavailable')
      d.log.warn('youtube.ban_protected_author', {
        connectionId: scope.connectionId,
        actionId: t.id,
        ruleId: t.ruleId,
        outcomeCode: s.code,
      });
    return { t, f: final(s.status, s.code) };
  });
  await commit(d, scope, entries);
}

/** Records a planned batch and claims its rows in one transaction. Null when nothing was claimed. */
async function claim(
  d: DispatchDeps,
  scope: ConnectionScope,
  b: PlannedBatch,
  pacificDay: string,
): Promise<{ id: string; items: QueuedTarget[] } | null> {
  const wanted = [...new Set(b.items.map((i) => i.actionId))];
  if (wanted.length === 0) return null;
  return withTransaction(d.pool, async (tx) => {
    const id = randomUUID();
    const targets = await d.backlog.targets(tx, scope, wanted);
    if (targets.length === 0) return null;
    await tx.query(
      `INSERT INTO youtube_write_batch (id, organization_id, brand_id, connection_id, pacific_day,
         moderation_status, ban_author, comment_external_ids, action_ids, state, created_at)
       VALUES ($4, $1, $2, $3, $5::date, $6, $7, $8, $9::uuid[], 'planned', $10)`,
      [
        ...scopeParams(scope),
        id,
        pacificDay,
        b.moderationStatus,
        b.banAuthor,
        refsOf(targets).map((r) => r.externalId),
        targets.map((t) => t.id),
        new Date(d.clock.now()),
      ],
    );
    const n = await d.backlog.markInFlight(tx, scope, id, wanted);
    const claimed = n === wanted.length ? new Set(wanted) : await inFlightOf(tx, scope, id);
    const items = targets.filter((t) => claimed.has(t.id));
    if (items.length === 0) {
      await tx.query(`DELETE FROM youtube_write_batch WHERE ${SCOPED} AND id = $4`, [
        ...scopeParams(scope),
        id,
      ]);
      return null;
    }
    if (items.length !== targets.length) await setItems(tx, scope, id, items);
    return { id, items };
  });
}

async function inFlightOf(q: Queryable, scope: ConnectionScope, batchId: string) {
  const r = await q.query<{ action_id: string }>(
    `SELECT action_id FROM youtube_action_queue
      WHERE ${SCOPED} AND batch_id = $4 AND state = 'in_flight'`,
    [...scopeParams(scope), batchId],
  );
  return new Set(r.rows.map((x) => x.action_id));
}

async function setItems(
  q: Queryable,
  scope: ConnectionScope,
  batchId: string,
  items: readonly QueuedTarget[],
  sentAt?: Date,
): Promise<void> {
  await q.query(
    `UPDATE youtube_write_batch
        SET comment_external_ids = $5, action_ids = $6::uuid[],
            state = CASE WHEN $7::timestamptz IS NULL THEN state ELSE 'sent' END,
            sent_at = COALESCE($7::timestamptz, sent_at)
      WHERE ${SCOPED} AND id = $4`,
    [
      ...scopeParams(scope),
      batchId,
      refsOf(items).map((r) => r.externalId),
      items.map((t) => t.id),
      sentAt ?? null,
    ],
  );
}

/** Probes the items' comments: the probes by comment id, or the probe's failure. */
async function probe(
  d: DispatchDeps,
  items: readonly QueuedTarget[],
  acc: Acc,
): Promise<Map<string, CommentProbe> | ConnectorError> {
  try {
    const probes = await d.client.probeComments(refsOf(items));
    acc.unitsSpent += PROBE_UNITS;
    return new Map(probes.map((p) => [p.externalId, p]));
  } catch (err) {
    // Anything else is a bug or a crash: the batch stays for recoverInFlight.
    if (!(err instanceof ConnectorError)) throw err;
    if (!isQuotaRefusal(err)) acc.unitsSpent += PROBE_UNITS;
    return err;
  }
}

/** Items whose probe already decides them, and the ones still to write. */
function classify(
  items: readonly QueuedTarget[],
  probes: ReadonlyMap<string, CommentProbe>,
): { skip: Entry[]; keep: QueuedTarget[] } {
  const skip: Entry[] = [];
  const keep: QueuedTarget[] = [];
  for (const t of items) {
    const p = probes.get(t.commentExternalId);
    if (!p || p.state === 'gone')
      skip.push({ t, f: final('noop', 'comment_gone', { commentState: 'deleted' }) });
    else if (p.state === 'held' && t.kind === 'hide')
      skip.push({ t, f: final('noop', 'already_moderated', { commentState: 'hidden' }) });
    else if (
      p.updatedAt !== null &&
      t.platformSyncedAt !== null &&
      p.updatedAt.getTime() > t.platformSyncedAt.getTime()
    )
      // The rules saw an older text: re-read it and let them decide again.
      skip.push({ t, f: final('noop', 'comment_edited', { resync: true }) });
    else keep.push(t);
  }
  return { skip, keep };
}

/**
 * A failed probe or write. Quota, budget and auth stops requeue the batch and
 * end the cycle; throttles and transient errors requeue and are rethrown so the
 * job retries with backoff; anything else is final for these actions.
 */
async function fail(
  d: DispatchDeps,
  scope: ConnectionScope,
  batchId: string,
  items: readonly QueuedTarget[],
  e: ConnectorErrorInfo,
): Promise<StopReason | null> {
  const requeue = async () =>
    commit(d, scope, [], {
      batch: { id: batchId, state: 'failed', code: e.code },
      requeue: items.map((t) => t.id),
    });
  if (e.code === 'quota_exceeded' || e.code === 'quota_paused') {
    await requeue();
    return 'quota_exceeded';
  }
  if (e.code === 'quota_budget_exhausted') {
    await requeue();
    return 'budget';
  }
  if (e.kind === 'auth_expired') {
    await requeue();
    return 'auth';
  }
  if (e.kind === 'transient' || e.kind === 'rate_limited') {
    await requeue();
    throw new ConnectorError(e.kind, e.code, {
      ...(e.retryAfterMs !== null ? { retryAfterMs: e.retryAfterMs } : {}),
      reauthorize: e.reauthorize,
    });
  }
  // hold_not_allowed, forbidden and other permanent refusals: the review fallback flags these.
  await commit(
    d,
    scope,
    items.map((t) => ({ t, f: final('failed', e.code) })),
    { batch: { id: batchId, state: 'failed', code: e.code } },
  );
  return null;
}

async function liveBatch(
  d: DispatchDeps,
  scope: ConnectionScope,
  b: PlannedBatch,
  pacificDay: string,
  acc: Acc,
): Promise<StopReason | null> {
  const claimed = await claim(d, scope, b, pacificDay);
  if (!claimed) return null;
  const batchId = claimed.id;
  const confirm = { id: batchId, state: 'confirmed' as const, code: null };

  // Probe, settle what it decides, and return what is left to write (null when the batch ended).
  let units = 0;
  const probeAndSkip = async (
    items: readonly QueuedTarget[],
  ): Promise<QueuedTarget[] | StopReason | null> => {
    const probes = await probe(d, items, acc);
    if (probes instanceof ConnectorError) {
      if (!isQuotaRefusal(probes)) units += PROBE_UNITS;
      return fail(d, scope, batchId, items, probes.info());
    }
    units += PROBE_UNITS;
    const { skip, keep } = classify(items, probes);
    await commit(d, scope, skip, keep.length === 0 ? { batch: confirm } : {});
    return keep.length === 0 ? null : keep;
  };
  const write = async (items: readonly QueuedTarget[]) => {
    await setItems(d.pool, scope, batchId, items, new Date(d.clock.now()));
    const r = await d.client.actBatch({ action: b.action, targets: refsOf(items) });
    const refused = r.status === 'failed' && QUOTA_REFUSAL_CODES.has(r.error.code);
    if (!refused) {
      acc.unitsSpent += WRITE_UNITS;
      units += WRITE_UNITS;
    }
    return { r, refused };
  };

  let keep = await probeAndSkip(claimed.items);
  if (!Array.isArray(keep)) return keep;
  let sent = await write(keep);
  if (sent.r.status === 'not_found') {
    // One missing id fails the whole call: find out which, and retry the rest once.
    acc.batchesSent += 1;
    keep = await probeAndSkip(keep);
    if (!Array.isArray(keep)) return keep;
    sent = await write(keep);
    if (sent.r.status === 'not_found') {
      await commit(d, scope, [], {
        batch: { id: batchId, state: 'failed', code: 'not_found' },
        requeue: keep.map((t) => t.id),
      });
      return null;
    }
  } else if (!sent.refused) acc.batchesSent += 1;
  if (sent.r.status === 'failed') return fail(d, scope, batchId, keep, sent.r.error);

  const remainingUnits = budgetView(await d.ledger.usage(scope)).remainingUnits;
  const quota: AuditQuota = {
    units,
    batchSize: refsOf(keep).length,
    remainingUnits,
    pacificDay,
    simulated: false,
  };
  await commit(
    d,
    scope,
    keep.map((t) => ({
      t,
      f: applied(t, isFolded(t, b.banAuthor) ? 'rejected_with_ban' : null),
      quota,
    })),
    { batch: confirm },
  );
  return null;
}

async function dryRunBatch(
  d: DispatchDeps,
  scope: ConnectionScope,
  b: PlannedBatch,
  pacificDay: string,
): Promise<StopReason | null> {
  const targets = await d.backlog.targets(d.pool, scope, [
    ...new Set(b.items.map((i) => i.actionId)),
  ]);
  if (targets.length === 0) return null;
  const meter = d.ledger.meterFor(scope, { simulated: true });
  let ticket;
  try {
    ticket = await meter.reserve({ method: WRITE_METHOD, units: BATCH_UNITS, purpose: 'write' });
  } catch (err) {
    if (!isQuotaRefusal(err)) throw err;
    return (err as ConnectorError).code === 'quota_paused' ? 'quota_exceeded' : 'budget';
  }
  await meter.settle(ticket, { ok: true });
  const batchSize = refsOf(targets).length;
  const quota: AuditQuota = {
    units: BATCH_UNITS,
    batchSize,
    remainingUnits: budgetView(await d.ledger.usage(scope, { simulated: true })).remainingUnits,
    pacificDay,
    simulated: true,
  };
  await commit(
    d,
    scope,
    targets.map((t) => ({ t, f: final('noop', 'dry_run'), quota })),
  );
  d.log.info('youtube.dry_run_batch', {
    connectionId: scope.connectionId,
    action: b.action,
    batchSize,
    wouldCostUnits: BATCH_UNITS,
    remainingUnits: quota.remainingUnits,
  });
  return null;
}

/** Sends (or, in dry-run, simulates) the plan's batches in order, after its zero-cost outcomes. */
export async function dispatchPlan(
  d: DispatchDeps,
  scope: ConnectionScope,
  plan: CyclePlan,
  o: { dryRun: boolean; pacificDay: string },
): Promise<DispatchResult> {
  const acc: Acc = { batchesSent: 0, unitsSpent: 0 };
  await settleNow(d, scope, plan.settleNow);
  let stoppedBy: StopReason | null = null;
  for (const b of plan.batches) {
    stoppedBy = o.dryRun
      ? await dryRunBatch(d, scope, b, o.pacificDay)
      : await liveBatch(d, scope, b, o.pacificDay, acc);
    if (stoppedBy) break;
  }
  await pruneWriteBatches(d, scope);
  return { ...acc, stoppedBy };
}

/** The probe state that shows a sent write took effect. */
const REACHED: Partial<Record<ActionKind, CommentProbe['state']>> = {
  hide: 'held',
  unhide: 'visible',
  delete: 'gone',
  ban_author: 'gone',
};

/**
 * Repairs batches a dead run left behind: planned or sent, created before
 * `before` (default: one lease ago). A cycle that holds the connection's lease
 * passes the time it took the lease, so every unfinished batch of an earlier
 * holder is repaired at once. A planned batch was never sent: it is requeued. A
 * sent batch is probed (1 unit), never re-sent: actions whose comment is in the
 * desired state settle applied, the others are requeued. Probe failures are thrown.
 */
export async function recoverInFlight(
  d: DispatchDeps,
  scope: ConnectionScope,
  o: { before?: Date } = {},
): Promise<void> {
  const before = o.before ?? new Date(d.clock.now() - CYCLE_LEASE_MS);
  const stale = await d.pool.query<{
    id: string;
    state: 'planned' | 'sent';
    ban_author: boolean;
    pacific_day: string;
  }>(
    `SELECT id, state, ban_author, to_char(pacific_day, 'YYYY-MM-DD') AS pacific_day
       FROM youtube_write_batch
      WHERE ${SCOPED} AND state IN ('planned', 'sent') AND created_at < $4
      ORDER BY created_at, id`,
    [...scopeParams(scope), before],
  );
  for (const b of stale.rows) {
    const ids = [...(await inFlightOf(d.pool, scope, b.id))];
    const items = await d.backlog.targets(d.pool, scope, ids);
    if (b.state === 'planned' || items.length === 0) {
      await commit(d, scope, [], {
        batch:
          b.state === 'planned'
            ? { id: b.id, state: 'failed', code: 'restart_requeued' }
            : { id: b.id, state: 'confirmed', code: null },
        requeue: ids,
      });
      d.log.warn('youtube.batch_recovered', {
        connectionId: scope.connectionId,
        batchId: b.id,
        state: b.state,
        requeued: ids.length,
      });
      continue;
    }
    const probes = new Map(
      (await d.client.probeComments(refsOf(items))).map((p) => [p.externalId, p]),
    );
    const reached = items.filter((t) => probes.get(t.commentExternalId)?.state === REACHED[t.kind]);
    const reachedIds = new Set(reached.map((t) => t.id));
    const quota: AuditQuota = {
      units: BATCH_UNITS + PROBE_UNITS,
      batchSize: refsOf(items).length,
      remainingUnits: budgetView(await d.ledger.usage(scope)).remainingUnits,
      pacificDay: b.pacific_day,
      simulated: false,
    };
    await commit(
      d,
      scope,
      reached.map((t) => ({
        t,
        // A rejected comment is gone either way: whether the ban itself landed cannot be read back.
        f: applied(t, t.kind === 'ban_author' ? 'ban_unconfirmed' : 'confirmed_after_restart'),
        quota,
      })),
      {
        batch: { id: b.id, state: 'confirmed', code: null },
        requeue: items.filter((t) => !reachedIds.has(t.id)).map((t) => t.id),
      },
    );
    d.log.warn('youtube.batch_recovered', {
      connectionId: scope.connectionId,
      batchId: b.id,
      state: b.state,
      confirmed: reached.length,
      requeued: items.length - reached.length,
    });
  }
}

/** Deletes this connection's settled batches older than the retention window. Returns how many. */
async function pruneWriteBatches(
  d: Pick<DispatchDeps, 'pool' | 'clock'>,
  scope: ConnectionScope,
): Promise<number> {
  const r = await d.pool.query(
    `DELETE FROM youtube_write_batch
      WHERE ${SCOPED} AND state IN ('confirmed', 'failed') AND pacific_day < $4::date - $5::int`,
    [...scopeParams(scope), pacificDayKey(d.clock.now()), WRITE_BATCH_RETENTION_DAYS],
  );
  return r.rowCount ?? 0;
}
