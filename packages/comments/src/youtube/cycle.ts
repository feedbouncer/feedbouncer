// One poll-and-dispatch cycle of one YouTube connection, under the connection's
// lease. It reads new comments within the read allowance, plans the backlog into
// the write batches the budget affords, sends them, and schedules the next read
// (spread over what is left of the day) and the next dispatch. Nothing here
// spends quota beyond what the ledger's meter allows.
import type pg from 'pg';
import { ConnectorError, type Clock, type ConnectorRuntime } from '@feedbouncer/connectors';
import { JobError, type JobDefinition, type JobProducer } from '@feedbouncer/jobs';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import type { ActionOutcomeObserver, CommentAppliedHook } from '../hooks.js';
import { deliverPendingHooks } from '../jobs/pending-hooks.js';
import { YOUTUBE_CYCLE_JOB, type YouTubeCyclePayload } from '../jobs/specs.js';
import type { PgCommentStore } from '../store.js';
import type { PgYouTubeBacklog } from './backlog.js';
import { budgetView, nextReadDelayMs } from './budget.js';
import { dispatchPlan, recoverInFlight, type DispatchDeps } from './dispatch.js';
import type { PgYouTubeQuotaLedger } from './ledger.js';
import type { YouTubeNotices } from './notices.js';
import { pollChannel, type PollDeps } from './poll.js';
import { planCycle } from './planner.js';
import { nextPacificMidnight, pacificDayKey } from './quota-day.js';
import type { PgYouTubeSettings } from './settings.js';
import type { PgYouTubeState, YouTubeCycleState, YouTubeStatePatch } from './state.js';

/** Re-run soon while actions wait and the budget affords another batch. */
const DISPATCH_RETRY_MS = 60_000;

export interface YouTubeCycleDeps {
  pool: pg.Pool;
  runtime: Pick<ConnectorRuntime, 'connect'>;
  state: PgYouTubeState;
  settings: PgYouTubeSettings;
  ledger: PgYouTubeQuotaLedger;
  backlog: PgYouTubeBacklog;
  notices: YouTubeNotices;
  store: PgCommentStore;
  /** Enqueues the re-ingest of a comment edited since we read it. */
  producer: Pick<JobProducer, 'enqueue'>;
  /** Called for live comments that are new or whose text changed. */
  applied?: CommentAppliedHook;
  outcomes?: ActionOutcomeObserver;
  clock: Clock;
  log: Logger;
}

interface Connection {
  status: string;
  channelId: string;
}

async function loadConnection(
  d: YouTubeCycleDeps,
  scope: ConnectionScope,
): Promise<Connection | null> {
  const r = await d.pool.query<{ status: string; external_account_id: string }>(
    `SELECT status, external_account_id FROM connection
      WHERE organization_id = $1 AND brand_id = $2 AND id = $3 AND platform = 'youtube'`,
    [scope.organizationId, scope.brandId, scope.connectionId],
  );
  const row = r.rows[0];
  return row ? { status: row.status, channelId: row.external_account_id } : null;
}

const waiting = async (d: YouTubeCycleDeps, scope: ConnectionScope): Promise<number> => {
  const c = await d.backlog.counts(scope);
  return c.ban + c.reject + c.hold + c.publish;
};

const errorCode = (err: unknown): string =>
  err instanceof ConnectorError ? err.code : 'cycle_failed';

export function youtubeCycleJob(d: YouTubeCycleDeps): JobDefinition<YouTubeCyclePayload> {
  const now = () => new Date(d.clock.now());

  /** The cycle's work under the lease. Returns what to save when the lease is released. */
  async function run(
    scope: ConnectionScope,
    conn: Connection,
    s: YouTubeCycleState,
    log: Logger,
  ): Promise<{ patch: YouTubeStatePatch; hookError?: unknown }> {
    const start = d.clock.now();
    const midnight = nextPacificMidnight(start);
    const settings = await d.settings.get(scope);
    await d.notices.once(scope, 'backlog_overflow');

    const sleepUntilReset = async (
      reason: 'paused' | 'unavailable',
    ): Promise<{ patch: YouTubeStatePatch }> => {
      if (reason === 'paused') await d.notices.once(scope, 'quota_paused', await waiting(d, scope));
      return { patch: { nextReadAt: midnight, nextDispatchAt: null, lastErrorCode: null } };
    };

    let view = budgetView(await d.ledger.usage(scope));
    if (view.mode === 'paused') return sleepUntilReset('paused');
    if (view.mode === 'disabled' || view.mode === 'exhausted')
      return sleepUntilReset('unavailable');

    const client = await d.runtime.connect(scope);
    const dispatchDeps: DispatchDeps = {
      pool: d.pool,
      client,
      backlog: d.backlog,
      ledger: d.ledger,
      producer: d.producer,
      ...(d.outcomes && { outcomes: d.outcomes }),
      log,
      clock: d.clock,
    };
    await recoverInFlight(dispatchDeps, scope, { before: new Date(start) });

    const patch: YouTubeStatePatch = { lastErrorCode: null };
    let hookError: unknown;
    let unitsPerPoll = Math.max(1, s.lastReadUnits);
    let backlogWaiting = await waiting(d, scope);
    if (s.nextReadAt.getTime() <= start) {
      const pollDeps: PollDeps = {
        pool: d.pool,
        client,
        store: d.store,
        ...(d.applied && { applied: d.applied }),
        clock: now,
        log,
      };
      const polled = await pollChannel(
        pollDeps,
        scope,
        {
          ownerChannelId: conn.channelId,
          highWaterAt: s.highWaterAt,
          resumePageToken: s.resumePageToken,
        },
        backlogWaiting === 0 ? view.remainingUnits : view.readReserveRemaining,
      );
      unitsPerPoll = Math.max(1, polled.readUnits);
      Object.assign(patch, {
        highWaterAt: polled.newHighWaterAt,
        resumePageToken: polled.resumePageToken,
        lastReadUnits: unitsPerPoll,
      });
      hookError = polled.hookError;
      backlogWaiting = await waiting(d, scope);
      view = budgetView(await d.ledger.usage(scope));
      if (view.mode === 'paused') {
        const r = await sleepUntilReset('paused');
        return { patch: { ...patch, ...r.patch }, hookError };
      }
    }

    const planView = settings.dryRun
      ? budgetView(await d.ledger.usage(scope, { simulated: true }))
      : view;
    const plan = planCycle(await d.backlog.loadQueued(scope), {
      affordableBatches: planView.affordableBatches,
      ownerChannelId: conn.channelId,
      protectedAuthorIds: new Set(settings.protectedAuthorIds),
    });
    const sent = await dispatchPlan(dispatchDeps, scope, plan, {
      dryRun: settings.dryRun,
      pacificDay: pacificDayKey(start),
    });
    backlogWaiting = await waiting(d, scope);

    if (sent.stoppedBy === 'quota_exceeded') {
      await d.notices.once(scope, 'quota_paused', backlogWaiting);
      return { patch: { ...patch, nextReadAt: midnight, nextDispatchAt: null }, hookError };
    }

    const after = budgetView(await d.ledger.usage(scope, { simulated: settings.dryRun }));
    const readLeft = backlogWaiting === 0 ? after.remainingUnits : after.readReserveRemaining;
    if (s.nextReadAt.getTime() <= start)
      patch.nextReadAt = new Date(
        d.clock.now() +
          nextReadDelayMs({
            readAllowanceUnits: readLeft,
            unitsPerPoll,
            msUntilReset: midnight.getTime() - d.clock.now(),
          }),
      );
    patch.nextDispatchAt =
      backlogWaiting > 0 && after.affordableBatches > 0 && sent.stoppedBy === null
        ? new Date(d.clock.now() + DISPATCH_RETRY_MS)
        : null;
    return { patch, hookError };
  }

  return {
    ...YOUTUBE_CYCLE_JOB,
    handle: async (ctx, payload) => {
      const scope = ctx.scope;
      if (payload.connectionId !== scope.connectionId)
        throw new JobError('non_retryable', 'scope_mismatch');
      const conn = await loadConnection(d, scope);
      if (!conn) throw new JobError('non_retryable', 'connection_not_found');
      if (conn.status !== 'active') return { status: 'inactive' };

      const claim = await d.state.claim(scope, now());
      if (!claim) return { status: 'leased' };
      let failure: { error: unknown } | null = null;
      let patch: YouTubeStatePatch;
      try {
        if (d.applied)
          failure = await deliverPendingHooks(
            { store: d.store, applied: d.applied, now: () => d.clock.now() },
            scope,
            'youtube',
            ctx.log,
          );
        const r = await run(scope, conn, claim.state, ctx.log);
        patch = r.patch;
        if (r.hookError !== undefined) failure ??= { error: r.hookError };
      } catch (err) {
        patch = { lastErrorCode: errorCode(err) };
        failure = { error: err };
      }
      if (!(await d.state.release(scope, claim.leaseToken, now(), patch)))
        ctx.log.warn('youtube.lease_lost', { connectionId: scope.connectionId });
      if (failure) throw failure.error;
      return { status: 'done' };
    },
  };
}
