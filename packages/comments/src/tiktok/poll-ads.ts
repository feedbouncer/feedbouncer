// Polls one TikTok advertiser's comment listing (every ad, replies flat in the
// same pages), newest first and paged by number, back to the high-water mark;
// periodically a full scan re-reads the backfill window, which also refreshes
// the state of comments on ads that have ended. A pass may span jobs: its start
// time, window and next page are saved after every page. Page-number paging is
// made loss-free by moving the high-water mark only when a pass completes, and
// then to the newest comment seen less an overlap, so an item a concurrent
// delete shifted across a page boundary is read again by the next pass.
// Comments TikTok stops returning keep their last known state.
import { ConnectorError, type ConnectionCommentsPage } from '@feedbouncer/connectors';
import type { JobDefinition } from '@feedbouncer/jobs';
import { BACKFILL_DEFAULTS } from '../backfill/settings.js';
import { deliverPendingHooks } from '../jobs/pending-hooks.js';
import { TIKTOK_ADS_POLL_JOB, type TikTokPollPayload } from '../jobs/specs.js';
import { DAY_MS, SEC, activeAccount, ingestComment, type TikTokPollDeps } from './ingest.js';

const BG = { priority: 'background' } as const;
const PAGE_SIZE = 100;
/** TikTok reads at most 30 calendar dates per call, both ends inclusive. */
const MAX_WINDOW_MS = 29 * DAY_MS;

/** `[lower, until]` as windows of at most 29 days, newest first. */
function adWindows(lower: Date, until: Date): { since: Date; until: Date }[] {
  const out: { since: Date; until: Date }[] = [];
  let end = until.getTime();
  do {
    const since = Math.max(lower.getTime(), end - MAX_WINDOW_MS);
    out.push({ since: new Date(since), until: new Date(end) });
    end = since;
  } while (end > lower.getTime());
  return out;
}

export function tiktokAdsPollJob(d: TikTokPollDeps): JobDefinition<TikTokPollPayload> {
  return {
    ...TIKTOK_ADS_POLL_JOB,
    handle: async (ctx, payload) => {
      const counts = { pages: 0, created: 0, updated: 0, complete: false };
      const own = await activeAccount(d, ctx.scope, payload.connectionId);
      if (own === null) return counts;
      const failure: { error?: unknown } = {};
      if (d.applied) {
        const f = await deliverPendingHooks(
          { store: d.store, applied: d.applied, now: () => d.clock().getTime() },
          ctx.scope,
          'tiktok_ads',
          ctx.log,
        );
        if (f) failure.error = f.error;
      }
      const client = await d.runtime.connect(ctx.scope);
      const s = d.settings;
      const now = d.clock();
      let st = await d.polling.connectionState(ctx.scope, 'tiktok_ad_comments');
      if (st.passStartedAt === null) {
        st = {
          ...st,
          passStartedAt: now,
          passNewestAt: null,
          resumePage: null,
          resumeCursor: null,
        };
        await d.polling.saveConnectionState(ctx.scope, st);
      }
      // Everything about a pass derives from its start, so a resumed pass reads the same windows.
      const start = st.passStartedAt!;
      const full =
        st.lastFullScanAt === null ||
        start.getTime() - st.lastFullScanAt.getTime() >= s.adsFullScanIntervalSec * SEC;
      const windowLower = new Date(start.getTime() - BACKFILL_DEFAULTS.windowDays * DAY_MS);
      const lower = full ? windowLower : (st.highWaterAt ?? windowLower);
      const windows = adWindows(lower, start);
      const firstPass = st.lastFullScanAt === null;
      let cap = firstPass
        ? BACKFILL_DEFAULTS.maxComments - (await d.polling.backfilledCount(ctx.scope))
        : Infinity;
      let w = Number(st.resumeCursor ?? 0);
      let page = st.resumePage ?? 1;
      let newest = st.passNewestAt;

      while (w < windows.length && cap > 0) {
        if (counts.pages >= s.maxPagesPerJob) {
          if ('error' in failure) throw failure.error;
          return counts;
        }
        const win = windows[w]!;
        const syncedAt = d.clock();
        let res: ConnectionCommentsPage;
        try {
          res = await client.listConnectionComments(
            { since: win.since, until: win.until, page, pageSize: PAGE_SIZE },
            BG,
          );
        } catch (err) {
          const ce = err instanceof ConnectorError ? err : null;
          await d.polling.saveConnectionState(ctx.scope, {
            nextPollAt: new Date(now.getTime() + (ce?.retryAfterMs ?? 0)),
            lastErrorCode: ce?.code ?? 'poll_failed',
          });
          throw err;
        }
        counts.pages++;
        await d.polling.upsertSources(
          ctx.scope,
          res.sources.filter((x) => x.kind === 'ad_post'),
        );
        let ended = !res.hasMore;
        for (const c of res.items) {
          if (c.postedAt < win.since) ended = true;
          if (c.postedAt < lower) continue;
          if (cap <= 0) break;
          const created = await ingestComment(
            d,
            ctx,
            c,
            { ownAccountExternalId: own, syncedAt, origin: firstPass ? 'backfill' : 'live' },
            counts,
            failure,
          );
          if (created && firstPass) cap--;
          if (newest === null || c.postedAt > newest) newest = c.postedAt;
        }
        if (ended) {
          w++;
          page = 1;
        } else page++;
        await d.polling.saveConnectionState(ctx.scope, {
          passNewestAt: newest,
          resumePage: page > 1 ? page : null,
          resumeCursor: w > 0 && w < windows.length ? String(w) : null,
        });
      }

      // Only TikTok's own timestamps move the mark; a pass that saw nothing keeps it.
      const candidate = newest === null ? null : new Date(newest.getTime() - s.adsOverlapSec * SEC);
      await d.polling.saveConnectionState(ctx.scope, {
        highWaterAt:
          candidate === null || (st.highWaterAt !== null && st.highWaterAt > candidate)
            ? st.highWaterAt
            : candidate,
        passStartedAt: null,
        passNewestAt: null,
        resumePage: null,
        resumeCursor: null,
        lastPolledAt: now,
        ...(full && { lastFullScanAt: start }),
        nextPollAt: new Date(now.getTime() + s.adsPollIntervalSec * SEC),
        lastErrorCode: null,
      });
      counts.complete = true;
      if ('error' in failure) throw failure.error;
      return counts;
    },
  };
}
