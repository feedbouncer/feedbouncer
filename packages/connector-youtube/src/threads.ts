// Reads: the channel-wide thread feed, reply counts, replies of one thread and one comment.
// Every id from a response is checked before it is kept; permalinks are built here from
// validated ids, never taken from the response; author profile URLs and images are dropped.
import {
  ConnectorError,
  type CallContext,
  type CommentRef,
  type NormalizedComment,
  type NormalizedThread,
  type Page,
  type PlatformState,
} from '@feedbouncer/connectors';
import * as z from 'zod';
import { youtubeCall } from './api.js';
import { MAX_BATCH } from './costs.js';
import { assertId, isId } from './ids.js';
import { cleanName, plainBody } from './text.js';

export type ThreadPage = Page<NormalizedThread> & {
  /** Threads skipped because an id, a date or the top-level comment failed validation. */
  readonly dropped: number;
};

const LIST_MAX = 100;

const SNIPPET = z.object({
  videoId: z.unknown().optional(),
  parentId: z.unknown().optional(),
  authorDisplayName: z.string().optional(),
  authorChannelId: z.object({ value: z.unknown() }).optional(),
  textOriginal: z.string().optional(),
  textDisplay: z.string().optional(),
  moderationStatus: z.string().optional(),
  publishedAt: z.string(),
  updatedAt: z.string().optional(),
});
const COMMENT = z.object({ id: z.unknown(), snippet: SNIPPET });
type RawComment = z.infer<typeof COMMENT>;

const THREAD = z.object({
  id: z.unknown(),
  snippet: z.object({
    videoId: z.unknown().optional(),
    totalReplyCount: z.number().int().min(0).max(1_000_000_000).optional(),
    topLevelComment: z.unknown(),
  }),
  replies: z.object({ comments: z.array(z.unknown()).max(LIST_MAX) }).optional(),
});

const LIST = z.object({
  items: z.array(z.unknown()).max(LIST_MAX).optional(),
  nextPageToken: z.unknown().optional(),
});

const STATE: Readonly<Record<string, PlatformState>> = {
  published: 'visible',
  heldForReview: 'hidden',
  likelySpam: 'hidden',
  rejected: 'deleted',
};

function date(v: string | undefined): Date | null {
  if (v === undefined) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `https://www.youtube.com/watch?v=<video>&lc=<comment>` from two validated ids. */
export function permalink(videoId: string, commentId: string): string {
  const u = new URL('https://www.youtube.com/watch');
  u.search = new URLSearchParams({ v: videoId, lc: commentId }).toString();
  return u.toString();
}

export function moderationState(status: string | undefined): PlatformState {
  return (status !== undefined && Object.hasOwn(STATE, status) && STATE[status]) || 'visible';
}

export function authorChannelId(raw: RawComment): string | null {
  const v = raw.snippet.authorChannelId?.value;
  return isId('channel', v) ? v : null;
}

/**
 * One comment resource. `videoId` is the caller's validated video id when it knows it (thread,
 * comment ref), otherwise the snippet's. `parent`: `null` for top level, a validated thread id
 * for a known reply, `'snippet'` to take the parent from the response. Null when invalid.
 */
function normalize(
  input: unknown,
  o: { videoId: string | null; parent: string | null | 'snippet'; replyCount?: number },
): NormalizedComment | null {
  const parsed = COMMENT.safeParse(input);
  if (!parsed.success) return null;
  const raw = parsed.data;
  const s = raw.snippet;
  const id = raw.id;
  const videoId = o.videoId ?? (isId('video', s.videoId) ? s.videoId : null);
  const postedAt = date(s.publishedAt);
  if (!isId('comment', id) || videoId === null || postedAt === null) return null;
  let parent: string | null = o.parent === 'snippet' ? null : o.parent;
  if (o.parent === 'snippet' && s.parentId !== undefined) {
    if (!isId('comment', s.parentId)) return null;
    parent = s.parentId;
  }
  const author = authorChannelId(raw);
  return {
    externalId: id,
    sourceExternalId: videoId,
    parentExternalId: parent,
    author:
      author === null
        ? null
        : { externalId: author, displayName: cleanName(s.authorDisplayName), profileUrl: null },
    // textDisplay is requested as plainText; either way the text is stored literally.
    body: plainBody(s.textOriginal ?? s.textDisplay ?? ''),
    postedAt,
    platformState: moderationState(s.moderationStatus),
    permalink: permalink(videoId, id),
    ...(o.replyCount !== undefined && { replyCount: o.replyCount }),
  };
}

function lastActivity(raw: unknown[], fallback: Date): Date {
  let max = fallback.getTime();
  for (const r of raw) {
    const p = COMMENT.safeParse(r);
    if (!p.success) continue;
    for (const d of [date(p.data.snippet.publishedAt), date(p.data.snippet.updatedAt)]) {
      if (d && d.getTime() > max) max = d.getTime();
    }
  }
  return new Date(max);
}

function normalizeThread(input: unknown): NormalizedThread | null {
  const parsed = THREAD.safeParse(input);
  if (!parsed.success) return null;
  const t = parsed.data;
  if (!isId('thread', t.id) || !isId('video', t.snippet.videoId)) return null;
  const threadId = t.id;
  const videoId = t.snippet.videoId;
  const replyCount = t.snippet.totalReplyCount ?? 0;
  const topLevel = normalize(t.snippet.topLevelComment, { videoId, parent: null, replyCount });
  if (topLevel === null || topLevel.externalId !== threadId) return null;
  const rawReplies = t.replies?.comments ?? [];
  const replies = rawReplies.flatMap((r) => {
    const c = normalize(r, { videoId, parent: threadId });
    return c === null ? [] : [c];
  });
  return {
    threadExternalId: threadId,
    videoExternalId: videoId,
    replyCount,
    lastActivityAt: lastActivity([t.snippet.topLevelComment, ...rawReplies], topLevel.postedAt),
    topLevel,
    replies,
  };
}

const nextCursor = (token: unknown): string | null =>
  token === undefined || token === null || token === '' ? null : assertId('pageToken', token);

/** One page (100 threads, 1 unit) of `commentThreads.list?allThreadsRelatedToChannelId`, newest first. */
export async function listChannelThreads(
  ctx: CallContext,
  req: { cursor: string | null },
): Promise<ThreadPage> {
  const q: Record<string, string> = {
    allThreadsRelatedToChannelId: assertId('channel', ctx.externalAccountId),
    part: 'snippet,replies',
    order: 'time',
    maxResults: String(LIST_MAX),
    textFormat: 'plainText',
  };
  if (req.cursor !== null) q['pageToken'] = assertId('pageToken', req.cursor);
  const res = await youtubeCall(ctx, 'commentThreads.list', q, LIST);
  const raw = res?.items ?? [];
  const items = raw.flatMap((t) => {
    const n = normalizeThread(t);
    return n === null ? [] : [n];
  });
  return { items, nextCursor: nextCursor(res?.nextPageToken), dropped: raw.length - items.length };
}

/** Each thread's `totalReplyCount` for 1 unit; threads Google did not return are absent. */
export async function probeThreadReplyCounts(
  ctx: CallContext,
  threadIds: readonly string[],
): Promise<Map<string, number>> {
  if (threadIds.length > MAX_BATCH) throw new ConnectorError('permanent', 'batch_too_large');
  const ids = [...new Set(threadIds.map((id) => assertId('thread', id)))];
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const res = await youtubeCall(
    ctx,
    'commentThreads.list',
    { id: ids.join(','), part: 'snippet' },
    LIST,
  );
  const wanted = new Set(ids);
  for (const item of res?.items ?? []) {
    const t = THREAD.safeParse(item);
    if (!t.success || typeof t.data.id !== 'string' || !wanted.has(t.data.id)) continue;
    counts.set(t.data.id, t.data.snippet.totalReplyCount ?? 0);
  }
  return counts;
}

/**
 * Replies of one thread (`comments.list?parentId=`), oldest first. `sourceExternalId` is the
 * thread id here; each reply's `sourceExternalId` is its video id.
 */
export async function listThreadReplies(
  ctx: CallContext,
  req: { sourceExternalId: string; cursor: string | null; limit: number },
): Promise<Page<NormalizedComment> & { dropped: number }> {
  const threadId = assertId('thread', req.sourceExternalId);
  const q: Record<string, string> = {
    parentId: threadId,
    part: 'snippet',
    maxResults: String(Math.min(Math.max(Math.trunc(req.limit), 1), LIST_MAX)),
    textFormat: 'plainText',
  };
  if (req.cursor !== null) q['pageToken'] = assertId('pageToken', req.cursor);
  const res = await youtubeCall(ctx, 'comments.list', q, LIST);
  const raw = res?.items ?? [];
  const items = raw.flatMap((r) => {
    const c = normalize(r, { videoId: null, parent: 'snippet' });
    return c === null || c.parentExternalId !== threadId ? [] : [c];
  });
  return { items, nextCursor: nextCursor(res?.nextPageToken), dropped: raw.length - items.length };
}

/** One comment by id (`comments.list?id=`); null when Google no longer returns it. */
export async function getComment(
  ctx: CallContext,
  ref: CommentRef,
): Promise<NormalizedComment | null> {
  const videoId = assertId('video', ref.sourceExternalId);
  const id = assertId('comment', ref.externalId);
  const res = await youtubeCall(
    ctx,
    'comments.list',
    { id, part: 'snippet', textFormat: 'plainText' },
    LIST,
  );
  for (const item of res?.items ?? []) {
    const c = normalize(item, { videoId, parent: 'snippet' });
    if (c !== null && c.externalId === id) return c;
  }
  return null;
}

export { COMMENT, LIST };
export type { NormalizedThread };
