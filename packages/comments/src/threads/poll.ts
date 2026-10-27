// Polls one Threads account. Post discovery lists the account's recent posts; every due post
// then has its conversation (all replies, at any depth) read newest first back to its
// high-water mark, a page of up to 100 replies per call. A webhook only makes its post due and
// records the reply id as pending: the replies of a burst arrive together in those pages, and
// whatever a finished read did not return is looked up one by one. A post seen for the first
// time through a webhook is checked to belong to the account before anything is read from it.
// Progress is saved after every page, so a throttled or interrupted job resumes where it
// stopped. One unreadable post never fails the others.
import {
  THREADS_ACTIVE_POST_DAYS,
  THREADS_FULL_SCAN_INTERVAL_SEC,
  THREADS_MAX_PAGES_PER_SOURCE_PASS,
  THREADS_PENDING_LOOKUPS_PER_PASS,
  THREADS_POLL_OVERLAP_SEC,
  THREADS_QUIET_POST_POLL_INTERVAL_SEC,
  THREADS_SOURCES_PER_PASS,
} from '@feedbouncer/connector-threads';
import {
  ConnectorError,
  type Clock,
  type ConnectionClient,
  type ConnectionDirectory,
  type ConnectorRuntime,
  type NormalizedComment,
} from '@feedbouncer/connectors';
import { JobError, type JobContext, type JobDefinition } from '@feedbouncer/jobs';
import { BACKFILL_DEFAULTS } from '../backfill/settings.js';
import type { CommentAppliedHook } from '../hooks.js';
import { ingestComment } from '../ingest-comment.js';
import { deliverPendingHooks } from '../jobs/pending-hooks.js';
import { sourceFailure } from '../jobs/poll.js';
import { THREADS_POLL_JOB } from '../jobs/specs.js';
import type { IngestOrigin, PgCommentStore } from '../store.js';
import type { ClaimedThread, PgThreadsPolling } from './polling.js';

/** Worker settings (THREADS_POLL_INTERVAL_SEC, THREADS_DISCOVERY_INTERVAL_SEC). */
export interface ThreadsPollSettings {
  /** How often a post that is still active is read again without a webhook. */
  pollIntervalSec: number;
  /** How often the account's recent posts are listed. */
  discoveryIntervalSec: number;
}

export interface ThreadsPollDeps {
  readonly runtime: ConnectorRuntime;
  readonly directory: ConnectionDirectory;
  readonly polling: PgThreadsPolling;
  readonly store: PgCommentStore;
  readonly clock: Clock;
  readonly settings: ThreadsPollSettings;
  /** Called for live comments that are new or whose text changed; a throw fails the job after the pass. */
  readonly applied?: CommentAppliedHook;
}

export type ThreadsPollResult = {
  /** Posts read (or checked) by this job. */
  sources: number;
  done: number;
  resumed: number;
  unavailable: number;
  /** Posts found to belong to another account. */
  foreign: number;
  created: number;
  updated: number;
  /** Pending replies whose lookup found them deleted. */
  deleted: number;
  /** Pending replies given up on after too many failed lookups. */
  pendingDropped: number;
};

const BG = { priority: 'background' } as const;
const SEC = 1000;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 100;
/** A post with a reply this recent polls at the active interval. */
const RECENT_REPLY_MS = 3 * DAY_MS;

interface Pass {
  readonly client: ConnectionClient;
  readonly ctx: JobContext;
  readonly own: string;
  readonly now: Date;
  readonly backfilling: boolean;
  /** Backfill replies still allowed on the connection's first pass. */
  cap: number;
  /** Individual lookups of pending replies this job may still make. */
  lookups: number;
  readonly counts: ThreadsPollResult;
  readonly failure: { error?: unknown };
}

const later = (now: Date, ms: number) => new Date(now.getTime() + ms);
const max = (a: Date | null, b: Date | null) => (a === null ? b : b === null || a >= b ? a : b);
const stalled = () => new ConnectorError('permanent', 'cursor_stalled');

/** Lists the account's recent posts. Returns false when the listing was cut short. */
async function discover(d: ThreadsPollDeps, p: Pass): Promise<boolean> {
  let cursor: string | null = null;
  for (let pages = THREADS_MAX_PAGES_PER_SOURCE_PASS; pages > 0; pages--) {
    const page = await p.client.listSources(cursor, BG);
    await d.polling.upsertSources(
      p.ctx.scope,
      page.items.filter((s) => s.kind === 'thread'),
    );
    if (page.nextCursor === null) return true;
    if (page.nextCursor === cursor) throw stalled();
    cursor = page.nextCursor;
  }
  return false;
}

async function ingest(
  d: ThreadsPollDeps,
  p: Pass,
  c: NormalizedComment,
  origin: IngestOrigin,
  syncedAt: Date,
): Promise<void> {
  await ingestComment(
    { store: d.store, applied: d.applied, clock: () => new Date(d.clock.now()) },
    { scope: p.ctx.scope, platform: 'threads', log: p.ctx.log },
    c,
    { ownAccountExternalId: p.own, syncedAt, origin },
    p.counts,
    p.failure,
  );
}

async function pollSource(
  d: ThreadsPollDeps,
  p: Pass,
  v: ClaimedThread,
): Promise<'done' | 'resumed'> {
  const { scope } = p.ctx;
  const s = v.poll;
  const now = p.now;
  const firstPass = s.lastFullScanAt === null;
  const fullScan =
    firstPass ||
    now.getTime() - s.lastFullScanAt!.getTime() >= THREADS_FULL_SCAN_INTERVAL_SEC * SEC;
  const window = new Date(now.getTime() - BACKFILL_DEFAULTS.windowDays * DAY_MS);
  // Null: read back to the backfill window. A saved cursor keeps the boundary it started with.
  const boundary =
    s.resumeCursor !== null
      ? s.resumeBoundary
      : fullScan
        ? null
        : s.highWaterAt !== null
          ? new Date(s.highWaterAt.getTime() - THREADS_POLL_OVERLAP_SEC * SEC)
          : window;
  const floor = boundary !== null && boundary > window ? boundary : window;
  const origin: IngestOrigin = p.backfilling && firstPass ? 'backfill' : 'live';
  let cursor = s.resumeCursor;
  let newest = s.resumeNewestAt;
  let lastReply = s.lastCommentAt;
  let pages = THREADS_MAX_PAGES_PER_SOURCE_PASS;
  for (;;) {
    const syncedAt = new Date(d.clock.now());
    const page = await p.client.listComments(
      { sourceExternalId: v.externalId, cursor, limit: PAGE_SIZE },
      BG,
    );
    pages--;
    let ended = page.nextCursor === null;
    const read: string[] = [];
    for (const c of page.items) {
      if (c.postedAt < floor || (origin === 'backfill' && p.cap <= 0)) {
        ended = true;
        break;
      }
      await ingest(d, p, c, origin, syncedAt);
      read.push(c.externalId);
      newest = max(newest, c.postedAt);
      lastReply = max(lastReply, c.postedAt);
      if (origin === 'backfill') p.cap--;
    }
    await d.polling.resolvePending(scope, read);
    if (ended) {
      const active =
        (lastReply !== null && now.getTime() - lastReply.getTime() <= RECENT_REPLY_MS) ||
        (v.postedAt !== null &&
          now.getTime() - v.postedAt.getTime() <= THREADS_ACTIVE_POST_DAYS * DAY_MS);
      await d.polling.saveSourcePoll(scope, v.sourceId, {
        highWaterAt: max(s.highWaterAt, newest),
        resumeCursor: null,
        resumeBoundary: null,
        resumeNewestAt: null,
        lastCommentAt: lastReply,
        lastPolledAt: now,
        lastFullScanAt: boundary === null ? now : s.lastFullScanAt,
        nextPollAt: later(
          now,
          (active ? d.settings.pollIntervalSec : THREADS_QUIET_POST_POLL_INTERVAL_SEC) * SEC,
        ),
        unavailableSince: null,
        lastErrorCode: null,
      });
      await lookUpPending(d, p, v);
      return 'done';
    }
    if (page.nextCursor === cursor) throw stalled();
    cursor = page.nextCursor;
    await d.polling.saveSourcePoll(scope, v.sourceId, {
      resumeCursor: cursor,
      resumeBoundary: boundary,
      resumeNewestAt: newest,
      lastCommentAt: lastReply,
      lastPolledAt: now,
    });
    if (pages <= 0) {
      await d.polling.saveSourcePoll(scope, v.sourceId, { nextPollAt: now });
      return 'resumed';
    }
  }
}

/**
 * Replies a webhook announced that the finished read did not return (deleted, filtered by
 * Threads, older than the read went) are fetched one by one. A reply that no longer exists is
 * marked deleted; one that cannot be fetched is retried by later passes, then given up.
 */
async function lookUpPending(d: ThreadsPollDeps, p: Pass, v: ClaimedThread): Promise<void> {
  if (p.lookups <= 0) return;
  const { scope } = p.ctx;
  const failed: string[] = [];
  try {
    for (const row of await d.polling.pendingFor(scope, v.externalId, p.lookups)) {
      p.lookups--;
      const ref = { sourceExternalId: v.externalId, externalId: row.externalId };
      const syncedAt = new Date(d.clock.now());
      let found: NormalizedComment | null;
      try {
        found = await p.client.getComment(ref);
      } catch (err) {
        if (
          err instanceof ConnectorError &&
          (err.kind === 'transient' || err.kind === 'permanent')
        ) {
          failed.push(row.externalId);
          continue;
        }
        throw err;
      }
      if (found !== null) await ingest(d, p, found, 'live', syncedAt);
      else if ((await d.store.markDeleted(scope, ref, syncedAt)) !== null) p.counts.deleted++;
      await d.polling.resolvePending(scope, [row.externalId]);
    }
  } finally {
    p.counts.pendingDropped += await d.polling.bumpPending(scope, failed);
  }
}

/** A post nothing can be read from counts against its pending replies, so they cannot pile up. */
async function giveUpPending(d: ThreadsPollDeps, p: Pass, v: ClaimedThread): Promise<void> {
  const rows = await d.polling.pendingFor(
    p.ctx.scope,
    v.externalId,
    THREADS_PENDING_LOOKUPS_PER_PASS,
  );
  p.counts.pendingDropped += await d.polling.bumpPending(
    p.ctx.scope,
    rows.map((r) => r.externalId),
  );
}

async function checkOwner(d: ThreadsPollDeps, p: Pass, v: ClaimedThread): Promise<boolean> {
  const ok = await p.client.verifySourceOwner(v.externalId);
  await d.polling.setOwnerVerified(p.ctx.scope, v.sourceId, ok);
  if (!ok) {
    p.counts.foreign++;
    p.ctx.log.warn('threads.foreign_source', {
      connectionId: p.ctx.scope.connectionId,
      sourceId: v.sourceId,
      sourceExternalId: v.externalId,
    });
  }
  return ok;
}

export function threadsPollJob(d: ThreadsPollDeps): JobDefinition<{ bucket: number }> {
  return {
    ...THREADS_POLL_JOB,
    handle: async (ctx) => {
      const counts: ThreadsPollResult = {
        sources: 0,
        done: 0,
        resumed: 0,
        unavailable: 0,
        foreign: 0,
        created: 0,
        updated: 0,
        deleted: 0,
        pendingDropped: 0,
      };
      const rec = await d.directory.load(ctx.scope);
      if (!rec) throw new JobError('non_retryable', 'connection_not_found');
      if (rec.status !== 'active') return counts;
      const failure: { error?: unknown } = {};
      if (d.applied) {
        const f = await deliverPendingHooks(
          { store: d.store, applied: d.applied, now: () => d.clock.now() },
          ctx.scope,
          'threads',
          ctx.log,
        );
        if (f) failure.error = f.error;
      }
      const client = await d.runtime.connect(ctx.scope);
      const now = new Date(d.clock.now());
      const state = await d.polling.discoveryState(ctx.scope);
      const backfilling = state.lastFullScanAt === null;
      const p: Pass = {
        client,
        ctx,
        own: rec.externalAccountId,
        now,
        backfilling,
        cap: backfilling
          ? BACKFILL_DEFAULTS.maxComments - (await d.polling.backfilledCount(ctx.scope))
          : Infinity,
        lookups: THREADS_PENDING_LOOKUPS_PER_PASS,
        counts,
        failure,
      };

      if (
        state.lastPolledAt === null ||
        now.getTime() - state.lastPolledAt.getTime() >= d.settings.discoveryIntervalSec * SEC
      ) {
        if (!(await discover(d, p)))
          ctx.log.warn('threads.discovery_truncated', { connectionId: ctx.scope.connectionId });
        await d.polling.saveDiscovery(ctx.scope, {
          lastPolledAt: now,
          nextPollAt: later(now, d.settings.discoveryIntervalSec * SEC),
        });
      }

      const due = await d.polling.claimDueSources(ctx.scope, now, THREADS_SOURCES_PER_PASS);
      let complete = due.length < THREADS_SOURCES_PER_PASS;
      for (const [i, v] of due.entries()) {
        if (backfilling && p.cap <= 0) {
          complete = false;
          await d.polling.saveSourcePoll(ctx.scope, v.sourceId, { nextPollAt: now });
          continue;
        }
        counts.sources++;
        try {
          if (v.ownerVerified === null && !(await checkOwner(d, p, v))) continue;
          const r = await pollSource(d, p, v);
          counts[r]++;
          if (r === 'resumed') complete = false;
        } catch (err) {
          const ce = err instanceof ConnectorError ? err : null;
          if (ce && sourceFailure(ce)) {
            await d.polling.saveSourcePoll(ctx.scope, v.sourceId, {
              unavailableSince: v.poll.unavailableSince ?? now,
              lastErrorCode: ce.kind === 'not_found' ? 'source_missing' : ce.code,
              nextPollAt: later(now, THREADS_QUIET_POST_POLL_INTERVAL_SEC * SEC),
              resumeCursor: null,
              resumeBoundary: null,
              resumeNewestAt: null,
              lastPolledAt: now,
            });
            await giveUpPending(d, p, v);
            counts.unavailable++;
            continue;
          }
          if (ce?.kind === 'transient') {
            complete = false;
            await d.polling.saveSourcePoll(ctx.scope, v.sourceId, {
              nextPollAt: later(now, ce.retryAfterMs ?? d.settings.pollIntervalSec * SEC),
            });
            continue;
          }
          // Throttled, re-authorization needed, or a bug: this and the untried posts keep
          // their cursors and wait, and the job stops.
          const retryAt = later(now, ce?.kind === 'rate_limited' ? (ce.retryAfterMs ?? 0) : 0);
          for (const rest of due.slice(i))
            await d.polling
              .saveSourcePoll(ctx.scope, rest.sourceId, { nextPollAt: retryAt })
              .catch((saveErr: unknown) =>
                ctx.log.warn('threads.poll_defer_failed', {
                  errorName: saveErr instanceof Error ? saveErr.name : 'unknown',
                }),
              );
          throw err;
        }
      }
      // The connection's first pass ends when every listed post had its first read, or at the
      // cap. Recorded as a local time, never as a high-water mark.
      if (backfilling && (complete || p.cap <= 0))
        await d.polling.saveDiscovery(ctx.scope, { lastFullScanAt: now });
      if ('error' in failure) throw failure.error;
      return counts;
    },
  };
}
