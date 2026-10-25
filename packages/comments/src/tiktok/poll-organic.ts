// Polls one TikTok business account: refreshes its video list, then reads the
// comments of due videos newest first back to each video's high-water mark (to
// the backfill window on a video's first pass and on its periodic deep scan),
// with the replies of every comment read that has any. Progress is saved after
// every page, so a throttled or interrupted job resumes where it stopped. One
// unreadable video never fails the others.
import {
  ConnectorError,
  type ConnectionClient,
  type NormalizedComment,
} from '@feedbouncer/connectors';
import type { JobContext, JobDefinition } from '@feedbouncer/jobs';
import { BACKFILL_DEFAULTS } from '../backfill/settings.js';
import { deliverPendingHooks } from '../jobs/pending-hooks.js';
import { ingestComment, type IngestCounts } from '../ingest-comment.js';
import { sourceFailure } from '../jobs/poll.js';
import { TIKTOK_POLL_JOB, type TikTokPollPayload } from '../jobs/specs.js';
import type { IngestOrigin } from '../store.js';
import { DAY_MS, SEC, activeAccount, type TikTokPollDeps } from './ingest.js';
import type { ClaimedVideo, ConnectionPollState } from './polling.js';

const BG = { priority: 'background' } as const;
const PAGE_SIZE = 30;
/** A video with a comment this recent polls at the active interval. */
const RECENT_COMMENT_MS = 7 * DAY_MS;

interface Pass {
  readonly client: ConnectionClient;
  readonly ctx: JobContext;
  readonly own: string;
  readonly now: Date;
  readonly state: ConnectionPollState;
  readonly backfilling: boolean;
  /** Backfill comments still allowed on the connection's first pass. */
  cap: number;
  pages: number;
  readonly counts: IngestCounts;
  readonly failure: { error?: unknown };
}

const later = (now: Date, ms: number) => new Date(now.getTime() + ms);
const max = (a: Date | null, b: Date | null) => (a === null ? b : b === null || a >= b ? a : b);
const stalled = () => new ConnectorError('permanent', 'cursor_stalled');

/** Pages the video list from its saved cursor; true once the whole list was read. */
async function discover(d: TikTokPollDeps, p: Pass): Promise<boolean> {
  let cursor = p.state.resumeCursor;
  while (p.pages > 0) {
    const page = await p.client.listSources(cursor, BG);
    p.pages--;
    await d.polling.upsertSources(
      p.ctx.scope,
      page.items.filter((s) => s.kind === 'video'),
    );
    if (page.nextCursor === null) {
      await d.polling.saveConnectionState(p.ctx.scope, {
        resumeCursor: null,
        lastPolledAt: p.now,
        nextPollAt: later(p.now, d.settings.videoDiscoveryIntervalSec * SEC),
      });
      return true;
    }
    if (page.nextCursor === cursor) throw stalled();
    cursor = page.nextCursor;
    await d.polling.saveConnectionState(p.ctx.scope, { resumeCursor: cursor });
  }
  return false;
}

async function ingest(
  d: TikTokPollDeps,
  p: Pass,
  c: NormalizedComment,
  origin: IngestOrigin,
  syncedAt: Date,
): Promise<void> {
  const created = await ingestComment(
    d,
    p.ctx,
    c,
    { ownAccountExternalId: p.own, syncedAt, origin },
    p.counts,
    p.failure,
  );
  if (created && origin === 'backfill') p.cap--;
}

/**
 * Reads every reply of one comment; stops early once the backfill cap is reached. Reply pages
 * count toward the job's page budget, so the job yields after the comment page being read.
 */
async function readReplies(
  d: TikTokPollDeps,
  p: Pass,
  parent: NormalizedComment,
  origin: IngestOrigin,
): Promise<Date | null> {
  let cursor: string | null = null;
  let newest: Date | null = null;
  for (;;) {
    const syncedAt = d.clock();
    const page = await p.client.listReplies(
      {
        parent: { sourceExternalId: parent.sourceExternalId, externalId: parent.externalId },
        cursor,
        limit: PAGE_SIZE,
      },
      BG,
    );
    p.pages--;
    if (page === null) return newest;
    for (const r of page.items) {
      if (origin === 'backfill' && p.cap <= 0) return newest;
      await ingest(d, p, r, origin, syncedAt);
      newest = max(newest, r.postedAt);
    }
    if (page.nextCursor === null) return newest;
    if (page.nextCursor === cursor) throw stalled();
    cursor = page.nextCursor;
  }
}

async function pollVideo(d: TikTokPollDeps, p: Pass, v: ClaimedVideo): Promise<'done' | 'resumed'> {
  const { scope } = p.ctx;
  const s = v.poll;
  const now = p.now;
  const firstPass = s.lastFullScanAt === null;
  const backfillDoneAt = p.state.lastFullScanAt;
  const deep =
    firstPass ||
    now.getTime() - s.lastFullScanAt!.getTime() >= d.settings.deepScanIntervalSec * SEC;
  const boundary = s.resumeCursor !== null ? s.resumeBoundary : deep ? null : s.highWaterAt;
  const window = new Date(now.getTime() - BACKFILL_DEFAULTS.windowDays * DAY_MS);
  const origin: IngestOrigin = p.backfilling && firstPass ? 'backfill' : 'live';
  let cursor = s.resumeCursor;
  let newest = s.resumeNewestAt;
  let lastComment = s.lastCommentAt;
  for (;;) {
    const syncedAt = d.clock();
    const page = await p.client.listComments(
      { sourceExternalId: v.externalId, cursor, limit: PAGE_SIZE },
      BG,
    );
    p.pages--;
    let ended = page.nextCursor === null;
    for (const c of page.items) {
      if (origin === 'backfill' && p.cap <= 0) {
        ended = true;
        break;
      }
      const top = c.parentExternalId === null;
      if (top && (c.postedAt < window || (boundary !== null && c.postedAt <= boundary)))
        ended = true;
      if (top && c.postedAt < window) continue;
      await ingest(d, p, c, origin, syncedAt);
      if (top) newest = max(newest, c.postedAt);
      lastComment = max(lastComment, c.postedAt);
      if (top && (c.replyCount ?? 0) > 0)
        lastComment = max(lastComment, await readReplies(d, p, c, origin));
    }
    if (ended) {
      const active =
        (lastComment !== null && now.getTime() - lastComment.getTime() <= RECENT_COMMENT_MS) ||
        (v.postedAt !== null &&
          now.getTime() - v.postedAt.getTime() <= d.settings.activeVideoDays * DAY_MS) ||
        (backfillDoneAt !== null &&
          v.discoveredAt > backfillDoneAt &&
          now.getTime() - v.discoveredAt.getTime() <= d.settings.activeVideoDays * DAY_MS);
      await d.polling.saveSourcePoll(scope, v.sourceId, {
        highWaterAt: max(s.highWaterAt, newest),
        resumeCursor: null,
        resumeBoundary: null,
        resumeNewestAt: null,
        lastCommentAt: lastComment,
        lastPolledAt: now,
        lastFullScanAt: boundary === null ? now : s.lastFullScanAt,
        nextPollAt: later(
          now,
          (active ? d.settings.pollIntervalSec : d.settings.quietVideoPollIntervalSec) * SEC,
        ),
        unavailableSince: null,
        lastErrorCode: null,
      });
      return 'done';
    }
    if (page.nextCursor === cursor) throw stalled();
    cursor = page.nextCursor;
    await d.polling.saveSourcePoll(scope, v.sourceId, {
      resumeCursor: cursor,
      resumeBoundary: boundary,
      resumeNewestAt: newest,
      lastPolledAt: now,
    });
    if (p.pages <= 0) {
      await d.polling.saveSourcePoll(scope, v.sourceId, { nextPollAt: now });
      return 'resumed';
    }
  }
}

export function tiktokPollJob(d: TikTokPollDeps): JobDefinition<TikTokPollPayload> {
  return {
    ...TIKTOK_POLL_JOB,
    handle: async (ctx, payload) => {
      const counts = { videos: 0, done: 0, resumed: 0, unavailable: 0, created: 0, updated: 0 };
      const own = await activeAccount(d, ctx.scope, payload.connectionId);
      if (own === null) return counts;
      const failure: { error?: unknown } = {};
      if (d.applied) {
        const f = await deliverPendingHooks(
          { store: d.store, applied: d.applied, now: () => d.clock().getTime() },
          ctx.scope,
          'tiktok',
          ctx.log,
        );
        if (f) failure.error = f.error;
      }
      const client = await d.runtime.connect(ctx.scope);
      const now = d.clock();
      const state = await d.polling.connectionState(ctx.scope, 'tiktok_videos');
      const backfilling = state.lastFullScanAt === null;
      const p: Pass = {
        client,
        ctx,
        own,
        now,
        state,
        backfilling,
        cap: backfilling
          ? BACKFILL_DEFAULTS.maxComments - (await d.polling.backfilledCount(ctx.scope))
          : Infinity,
        pages: d.settings.maxPagesPerJob,
        counts,
        failure,
      };
      const discoveryDue =
        state.resumeCursor !== null ||
        state.lastPolledAt === null ||
        now.getTime() - state.lastPolledAt.getTime() >= d.settings.videoDiscoveryIntervalSec * SEC;
      const listed = discoveryDue ? await discover(d, p) : true;

      const due = await d.polling.claimDueVideos(ctx.scope, now, d.settings.maxSourcesPerJob);
      let complete = listed && due.length < d.settings.maxSourcesPerJob;
      for (const [i, v] of due.entries()) {
        if (p.pages <= 0 || (backfilling && p.cap <= 0)) {
          complete = false;
          await d.polling.saveSourcePoll(ctx.scope, v.sourceId, { nextPollAt: now });
          continue;
        }
        counts.videos++;
        try {
          const r = await pollVideo(d, p, v);
          counts[r]++;
          if (r === 'resumed') complete = false;
        } catch (err) {
          const ce = err instanceof ConnectorError ? err : null;
          if (ce && sourceFailure(ce)) {
            await d.polling.saveSourcePoll(ctx.scope, v.sourceId, {
              unavailableSince: v.poll.unavailableSince ?? now,
              lastErrorCode: ce.kind === 'not_found' ? 'source_missing' : ce.code,
              nextPollAt: later(now, d.settings.sourceUnavailableRetrySec * SEC),
              resumeCursor: null,
              resumeBoundary: null,
              resumeNewestAt: null,
              lastPolledAt: now,
            });
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
          // Throttled, re-authorization needed, or a bug: this and the untried videos
          // keep their cursors and wait, and the job stops.
          const retryAt = later(now, ce?.kind === 'rate_limited' ? (ce.retryAfterMs ?? 0) : 0);
          for (const rest of due.slice(i))
            await d.polling
              .saveSourcePoll(ctx.scope, rest.sourceId, { nextPollAt: retryAt })
              .catch((saveErr: unknown) =>
                ctx.log.warn('tiktok.poll_defer_failed', {
                  errorName: saveErr instanceof Error ? saveErr.name : 'unknown',
                }),
              );
          throw err;
        }
      }
      // The connection's first pass ends when every listed video had its first pass, or at the
      // cap. Recorded as a local time, never as a high-water mark.
      if (backfilling && (complete || p.cap <= 0))
        await d.polling.saveConnectionState(ctx.scope, { lastFullScanAt: now });
      if ('error' in failure) throw failure.error;
      return counts;
    },
  };
}
