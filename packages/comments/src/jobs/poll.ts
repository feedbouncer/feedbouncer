// Polls the comments of ad posts (Facebook posts, Instagram media) tracked under
// one Page / IG connection. Each source is paged newest first back to its
// high-water mark (less an overlap for platform timestamp ordering); Instagram
// sources get a periodic full scan. A pass that outlives the job's soft deadline
// saves its cursor and resumes in the next job. Failures are per source: one
// unreadable post never fails the others. Every outcome moves the source's
// next_poll_at, so a failing source cannot hold its connection at the head of
// the due order.
import { JobError, type JobDefinition } from '@feedbouncer/jobs';
import {
  ConnectorError,
  type Clock,
  type ConnectionClient,
  type ConnectionDirectory,
  type ConnectorRuntime,
  type NormalizedComment,
  type Page,
} from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { PgCommentStore } from '../store.js';
import type { DueSource, PgAdTracking } from '../ads/tracking.js';
import { applyPlatformComment } from '../apply.js';
import type { IngestObserver } from './ingest.js';
import type { CommentAppliedHook } from '../hooks.js';
import { POLL_JOB, type PollPayload } from './specs.js';

export interface PollSettings {
  intervalSec: number;
  graceDays: number;
  maxSourcesPerJob: number;
  unavailableRetrySec: number;
  igDeepScanSec: number;
  /** Tolerance for platform timestamp ordering below the high-water mark. */
  overlapMs: number;
  /** Below the job timeout: no new page starts after it. */
  softDeadlineMs: number;
  pageSize: number;
}

interface PollDeps {
  store: PgCommentStore;
  tracking: PgAdTracking;
  clock: Clock;
  settings: PollSettings;
  observer?: IngestObserver;
  /** Called for live comments that are new or whose text changed; a throw retries the job. */
  applied?: CommentAppliedHook;
}

export async function pollSource(
  d: PollDeps & { client: ConnectionClient },
  scope: ConnectionScope,
  platform: 'facebook' | 'instagram',
  ownAccountExternalId: string,
  s: DueSource,
  deadlineMs: number,
): Promise<{ result: 'done' | 'resume'; created: number; updated: number }> {
  const at = new Date(d.clock.now());
  const deep =
    platform === 'instagram' &&
    (s.lastFullScanAt === null ||
      at.getTime() - s.lastFullScanAt.getTime() >= d.settings.igDeepScanSec * 1000);
  // A resumed pass keeps its original boundary even if high_water_at moved since.
  const boundary =
    s.resumeBoundary ??
    (deep || s.highWaterAt === null
      ? null
      : new Date(s.highWaterAt.getTime() - d.settings.overlapMs));
  let cursor = s.resumeCursor;
  let newest = s.resumeNewestAt;
  let created = 0;
  let updated = 0;
  const saveResume = (c: string) =>
    d.tracking.savePollProgress(scope, s.sourceId, {
      kind: 'resume',
      cursor: c,
      boundary,
      newestAt: newest,
      at,
    });
  for (;;) {
    let page: Page<NormalizedComment>;
    try {
      page = await d.client.listComments(
        {
          sourceExternalId: s.sourceExternalId,
          cursor,
          limit: d.settings.pageSize,
          includeReplies: true,
        },
        { priority: 'background' },
      );
    } catch (err) {
      // Keep this pass's place, so a deferred or retried job continues from here.
      if (cursor !== null) await saveResume(cursor);
      throw err;
    }
    for (const c of page.items) {
      const r = await applyPlatformComment(d.store, scope, c, {
        ownAccountExternalId,
        syncedAt: new Date(d.clock.now()),
        adSourceId: s.sourceId,
      });
      if (r.outcome === 'created') {
        created++;
        try {
          d.observer?.onIngested({
            platform,
            lagMs: Math.max(0, d.clock.now() - c.postedAt.getTime()),
            outcome: 'created',
            origin: 'live',
          });
        } catch {
          /* telemetry never fails a job */
        }
      } else if (r.outcome === 'updated') updated++;
      if (r.outcome !== 'stale' && r.bodyChanged) {
        await d.applied?.onApplied({
          scope,
          platform,
          commentId: r.commentId,
          body: c.body,
          outcome: r.outcome,
        });
      }
      if (newest === null || c.postedAt > newest) newest = c.postedAt;
    }
    const reachedBoundary =
      boundary !== null &&
      page.items.some((c) => c.parentExternalId === null && c.postedAt < boundary);
    if (reachedBoundary || page.nextCursor === null) {
      await d.tracking.savePollProgress(scope, s.sourceId, {
        kind: 'done',
        highWaterAt: newest,
        lastCommentAt: newest,
        fullScan: boundary === null,
        at,
        nextPollAt: new Date(at.getTime() + d.settings.intervalSec * 1000),
      });
      return { result: 'done', created, updated };
    }
    if (page.nextCursor === cursor) throw new ConnectorError('permanent', 'cursor_stalled');
    cursor = page.nextCursor;
    // Checked after a page: every job advances the pass, and a resume always has a cursor.
    if (d.clock.now() >= deadlineMs) {
      await saveResume(cursor);
      return { result: 'resume', created, updated };
    }
  }
}

/** What an unreadable source's code is when the media itself, or the whole account, is refused. */
const SOURCE_INACCESSIBLE = 'source_inaccessible';

/** The source itself is unreadable (deleted post, no access to the media): retry it much later. */
export const sourceFailure = (err: ConnectorError) =>
  err.kind === 'permanent' ||
  err.kind === 'unsupported' ||
  (err.kind === 'not_found' && err.code !== 'connection_not_found');

export function adPollJob(
  d: PollDeps & { runtime: ConnectorRuntime; directory: ConnectionDirectory },
): JobDefinition<PollPayload> {
  return {
    ...POLL_JOB,
    handle: async (ctx) => {
      const rec = await d.directory.load(ctx.scope);
      if (!rec) throw new JobError('non_retryable', 'connection_not_found');
      const counts = { sources: 0, done: 0, resumed: 0, unavailable: 0, created: 0, updated: 0 };
      let inaccessible = 0;
      if (rec.status !== 'active') return counts;
      const platform = rec.platform;
      if (platform !== 'facebook' && platform !== 'instagram')
        throw new JobError('non_retryable', 'unsupported_platform');

      const client = await d.runtime.connect(ctx.scope);
      const deadline = d.clock.now() + d.settings.softDeadlineMs;
      const due = await d.tracking.dueSources(ctx.scope, new Date(d.clock.now()), {
        graceDays: d.settings.graceDays,
        limit: d.settings.maxSourcesPerJob,
      });
      const later = (ms: number) => new Date(d.clock.now() + ms);
      const intervalMs = d.settings.intervalSec * 1000;
      for (const [i, s] of due.entries()) {
        if (i > 0 && d.clock.now() >= deadline) break;
        counts.sources++;
        try {
          const r = await pollSource(
            { ...d, client },
            ctx.scope,
            platform,
            rec.externalAccountId,
            s,
            deadline,
          );
          counts[r.result === 'done' ? 'done' : 'resumed']++;
          counts.created += r.created;
          counts.updated += r.updated;
        } catch (err) {
          const ce = err instanceof ConnectorError ? err : null;
          if (ce && sourceFailure(ce)) {
            await d.tracking.savePollProgress(ctx.scope, s.sourceId, {
              kind: 'unavailable',
              code: ce.kind === 'not_found' ? 'source_missing' : ce.code,
              at: new Date(d.clock.now()),
              retryAt: later(d.settings.unavailableRetrySec * 1000),
            });
            counts.unavailable++;
            if (ce.code === SOURCE_INACCESSIBLE) inaccessible++;
            continue;
          }
          // The runtime has flagged the connection; the scheduler skips it from now on.
          if (ce?.kind === 'auth_expired') throw err;
          if (ce?.kind === 'transient') {
            await d.tracking.savePollProgress(ctx.scope, s.sourceId, {
              kind: 'defer',
              retryAt: later(ce.retryAfterMs ?? intervalMs),
            });
            continue;
          }
          // Throttled (the framework defers the job) or a bug (it retries): this and the
          // untried sources wait, so the connection leaves the head of the due order.
          const retryAt = later(ce?.retryAfterMs ?? intervalMs);
          try {
            for (const rest of due.slice(i))
              await d.tracking.savePollProgress(ctx.scope, rest.sourceId, {
                kind: 'defer',
                retryAt,
              });
          } catch (deferErr) {
            ctx.log.warn('ads.poll_defer_failed', {
              sources: due.length - i,
              errorName: deferErr instanceof Error ? deferErr.name : 'unknown',
            });
          }
          throw err;
        }
      }
      // Every media refusing us at once means the account-level permission is gone,
      // not that each post is private: ask the owner to reconnect.
      if (inaccessible >= 2 && inaccessible === counts.sources) {
        await d.directory.markReauthRequired(ctx.scope, 'oauth_access_rejected');
        throw new JobError('non_retryable', 'permission_revoked');
      }
      return counts;
    },
  };
}
