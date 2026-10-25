// Reads a YouTube channel's new comments and replies into the store. The channel-wide
// thread feed is read newest first, back to the high-water mark; a reply sweep then
// checks the reply counts of recently active threads and fetches only the replies of
// threads whose count rose. Each call costs quota units, so a pass is bounded by pages
// and by the caller's read allowance. A pass that cannot finish keeps its place in
// `resumePageToken`; it only moves the high-water mark once it reaches known ground.
// One unreadable video never fails the pass. Comment bodies are never logged.
import type pg from 'pg';
import { commentFingerprint } from '@feedbouncer/db';
import {
  ConnectorError,
  isQuotaRefusal,
  type ConnectionClient,
  type NormalizedComment,
  type NormalizedThread,
} from '@feedbouncer/connectors';
import type { ConnectionScope } from '@feedbouncer/secrets';
import type { Logger } from '@feedbouncer/service-runtime';
import type { CommentAppliedHook } from '../hooks.js';
import { ingestComment } from '../ingest-comment.js';
import { sourceFailure } from '../jobs/poll.js';
import { upsertListedSource, type PgCommentStore } from '../store.js';

const MAX_FEED_PAGES = 5;
const MAX_REPLY_PAGES_PER_THREAD = 3;
const SWEEP_THREADS = 50;
const DAY_MS = 86_400_000;
/** The feed is ordered by publish time while activity also counts edits and replies: read a little past the mark. */
const OVERLAP_MS = 600_000;
const REPLY_PAGE_SIZE = 100;
const BG = { priority: 'background' } as const;

export interface PollDeps {
  pool: pg.Pool;
  client: Pick<ConnectionClient, 'listThreads' | 'probeThreadReplyCounts' | 'listComments'>;
  store: PgCommentStore;
  /** Called for live comments that are new or whose text changed. */
  applied?: CommentAppliedHook;
  clock: () => Date;
  log: Logger;
}

export interface PollState {
  /** The connected channel's id: the comments' own account. */
  ownerChannelId: string;
  highWaterAt: Date | null;
  resumePageToken: string | null;
}

export interface PollResult {
  /** Units the calls made cost (refused calls cost nothing). */
  readUnits: number;
  newHighWaterAt: Date | null;
  /** Where the next pass continues; null once this pass reached known ground. */
  resumePageToken: string | null;
  ingested: number;
  /** A rule-hook delivery failed; the pass finished, and the caller should fail its job afterwards. */
  hookError?: unknown;
}

interface Run {
  readonly d: PollDeps;
  readonly scope: ConnectionScope;
  readonly s: PollState;
  readonly allowance: number;
  readonly now: Date;
  units: number;
  ingested: number;
  newest: Date | null;
  resume: string | null;
  readonly failure: { error?: unknown };
  readonly counts: { created: number; updated: number };
}

/** The local budget refused the call, or Google reported the shared quota gone: stop, do not fail. */
const quotaStop = (err: unknown) =>
  isQuotaRefusal(err) || (err instanceof ConnectorError && err.code === 'quota_exceeded');

const hasRoom = (r: Run) => r.units < r.allowance;

/** One metered read. A refused call costs nothing; any other call is charged, failed ones included. */
async function read<T>(r: Run, call: () => Promise<T>): Promise<T> {
  try {
    const out = await call();
    r.units++;
    return out;
  } catch (err) {
    if (!isQuotaRefusal(err)) r.units++;
    throw err;
  }
}

async function ingest(r: Run, c: NormalizedComment, syncedAt: Date): Promise<void> {
  await ingestComment(
    r.d,
    { scope: r.scope, platform: 'youtube', log: r.d.log },
    c,
    { ownAccountExternalId: r.s.ownerChannelId, syncedAt, origin: 'live' },
    r.counts,
    r.failure,
  );
  r.ingested++;
}

async function saveThread(r: Run, t: NormalizedThread): Promise<void> {
  // Replies we hold: all of them when Google inlined every one, else only the inlined ones,
  // so the sweep sees the difference. A thread already stored keeps its count until then.
  const complete = t.replyCount <= t.replies.length;
  // A thread whose top-level comment was erased is not tracked again.
  await r.d.pool.query(
    `INSERT INTO youtube_thread AS y (organization_id, brand_id, connection_id, thread_external_id,
                                      video_external_id, reply_count, last_activity_at)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::int, $7::timestamptz
      WHERE NOT EXISTS (SELECT 1 FROM erased_comment WHERE connection_id = $3 AND fingerprint = $9)
     ON CONFLICT (connection_id, thread_external_id) DO UPDATE SET
       reply_count = CASE WHEN $8 THEN EXCLUDED.reply_count ELSE y.reply_count END,
       last_activity_at = GREATEST(y.last_activity_at, EXCLUDED.last_activity_at)
     WHERE y.organization_id = $1 AND y.brand_id = $2`,
    [
      r.scope.organizationId,
      r.scope.brandId,
      r.scope.connectionId,
      t.threadExternalId,
      t.videoExternalId,
      complete ? t.replyCount : t.replies.length,
      t.lastActivityAt,
      complete,
      commentFingerprint(r.scope.connectionId, t.threadExternalId),
    ],
  );
}

/** Pages the feed from the saved place back to the high-water mark. */
async function readFeed(r: Run): Promise<void> {
  const boundary = new Date(
    Math.max((r.s.highWaterAt?.getTime() ?? 0) - OVERLAP_MS, r.now.getTime() - 7 * DAY_MS),
  );
  const videos = new Set<string>();
  let cursor = r.s.resumePageToken;
  for (let pages = 0; pages < MAX_FEED_PAGES && hasRoom(r); pages++) {
    r.resume = cursor;
    const syncedAt = r.d.clock();
    const page = await read(r, () => r.d.client.listThreads(cursor, BG));
    for (const t of page.items) {
      if (!videos.has(t.videoExternalId)) {
        await upsertListedSource(r.d.pool, r.scope, t.videoExternalId, 'video');
        videos.add(t.videoExternalId);
      }
      await saveThread(r, t);
      await ingest(r, t.topLevel, syncedAt);
      for (const reply of t.replies) await ingest(r, reply, syncedAt);
      if (!r.newest || t.lastActivityAt > r.newest) r.newest = t.lastActivityAt;
    }
    const oldest = Math.min(...page.items.map((t) => t.lastActivityAt.getTime()));
    cursor = page.nextCursor;
    if (cursor === null || (page.items.length > 0 && oldest < boundary.getTime())) {
      r.resume = null;
      return;
    }
    if (cursor === r.resume) throw new ConnectorError('permanent', 'cursor_stalled');
    r.resume = cursor;
  }
}

/** A video whose comments cannot be read stops being polled; the pass goes on. */
async function markSourceUnavailable(r: Run, videoId: string, err: ConnectorError) {
  await r.d.pool.query(
    `UPDATE source SET active = false
      WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND external_id = $4`,
    [r.scope.organizationId, r.scope.brandId, r.scope.connectionId, videoId],
  );
  r.d.log.warn('youtube.source_unavailable', {
    connectionId: r.scope.connectionId,
    code: err.kind === 'not_found' ? 'source_missing' : err.code,
  });
}

/** Fetches the replies of one thread (up to MAX_REPLY_PAGES_PER_THREAD pages) and stores them. */
async function readReplies(r: Run, threadId: string, count: number): Promise<void> {
  let cursor: string | null = null;
  let newest: Date | null = null;
  for (let pages = 0; pages < MAX_REPLY_PAGES_PER_THREAD && hasRoom(r); pages++) {
    const syncedAt = r.d.clock();
    const page: Awaited<ReturnType<PollDeps['client']['listComments']>> = await read(r, () =>
      r.d.client.listComments({ sourceExternalId: threadId, cursor, limit: REPLY_PAGE_SIZE }, BG),
    );
    for (const c of page.items) {
      await ingest(r, c, syncedAt);
      if (!newest || c.postedAt > newest) newest = c.postedAt;
    }
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  await r.d.pool.query(
    `UPDATE youtube_thread
        SET reply_count = $5, last_activity_at = GREATEST(last_activity_at, COALESCE($6, last_activity_at))
      WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND thread_external_id = $4`,
    [r.scope.organizationId, r.scope.brandId, r.scope.connectionId, threadId, count, newest],
  );
}

async function sweepReplies(r: Run): Promise<void> {
  if (!hasRoom(r)) return;
  const { rows } = await r.d.pool.query<{
    thread_external_id: string;
    video_external_id: string;
    reply_count: number;
  }>(
    `SELECT thread_external_id, video_external_id, reply_count FROM youtube_thread
      WHERE organization_id = $1 AND brand_id = $2 AND connection_id = $3 AND last_activity_at > $4
      ORDER BY last_activity_at DESC, thread_external_id
      LIMIT ${SWEEP_THREADS}`,
    [
      r.scope.organizationId,
      r.scope.brandId,
      r.scope.connectionId,
      new Date(r.now.getTime() - 7 * DAY_MS),
    ],
  );
  if (rows.length === 0) return;
  const counts = await read(r, () =>
    r.d.client.probeThreadReplyCounts(
      rows.map((t) => t.thread_external_id),
      BG,
    ),
  );
  for (const t of rows) {
    const count = counts.get(t.thread_external_id);
    if (count === undefined || count <= t.reply_count || !hasRoom(r)) continue;
    try {
      await readReplies(r, t.thread_external_id, count);
    } catch (err) {
      if (!(err instanceof ConnectorError) || !sourceFailure(err) || quotaStop(err)) throw err;
      await markSourceUnavailable(r, t.video_external_id, err);
    }
  }
}

/**
 * One poll pass within `readAllowance` units. A refused or exhausted quota ends the pass
 * quietly, keeping its place; every other connector error propagates.
 */
export async function pollChannel(
  d: PollDeps,
  scope: ConnectionScope,
  s: PollState,
  readAllowance: number,
): Promise<PollResult> {
  const r: Run = {
    d,
    scope,
    s,
    allowance: readAllowance,
    now: d.clock(),
    units: 0,
    ingested: 0,
    newest: null,
    resume: s.resumePageToken,
    failure: {},
    counts: { created: 0, updated: 0 },
  };
  try {
    await readFeed(r);
    await sweepReplies(r);
  } catch (err) {
    if (!quotaStop(err)) throw err;
  }
  const finished = r.resume === null;
  const high =
    finished && r.newest && (!s.highWaterAt || r.newest > s.highWaterAt) ? r.newest : s.highWaterAt;
  return {
    readUnits: r.units,
    newHighWaterAt: high,
    resumePageToken: r.resume,
    ingested: r.ingested,
    ...('error' in r.failure && { hookError: r.failure.error }),
  };
}
