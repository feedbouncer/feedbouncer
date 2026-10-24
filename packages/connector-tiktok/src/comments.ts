import {
  ConnectorError,
  type CallContext,
  type CommentRef,
  type NormalizedComment,
  type Page,
} from '@feedbouncer/connectors';
import {
  OPAQUE_ID,
  opaqueId,
  sanitizeText,
  tiktokRequest,
  tiktokTime,
  username,
} from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';
import {
  callOf,
  checkCursor,
  nextCursor,
  onPermissionDenied,
  pageSchema,
  type SkipLog,
} from './call.js';

const id = z.string().regex(OPAQUE_ID);
/** One element of `comments` (list and reply list share the shape). V6/V7 corrections land here. */
const COMMENT_SCHEMA = z.object({
  comment_id: id,
  parent_comment_id: id.optional(),
  user_id: id,
  username: z.string().max(500).optional(),
  display_name: z.string().max(500).optional(),
  text: z.string().max(40_000),
  create_time: z.unknown(),
  status: z.string().max(40).optional(),
  reply_count: z.number().int().min(0).max(1_000_000).optional().catch(undefined),
});
const PAGE_SCHEMA = pageSchema('comments');
const MAX_PAGE = 30;
const GET_COMMENT_MAX_PAGES = 5;

function toComment(raw: unknown, sourceExternalId: string, parentFallback: string | null) {
  const r = COMMENT_SCHEMA.safeParse(raw);
  if (!r.success) return null;
  const c = r.data;
  let postedAt: Date;
  try {
    postedAt = tiktokTime(c.create_time);
  } catch {
    return null;
  }
  const handle = username(c.username);
  const name = c.display_name ?? c.username;
  const comment: NormalizedComment = {
    externalId: c.comment_id,
    sourceExternalId,
    parentExternalId: c.parent_comment_id ?? parentFallback,
    author: {
      externalId: c.user_id,
      displayName: name === undefined ? null : sanitizeText(name, 200),
      profileUrl: handle === null ? null : `https://www.tiktok.com/@${handle}`,
    },
    body: sanitizeText(c.text, 10_000),
    postedAt,
    platformState:
      c.status === 'DELETED' ? 'deleted' : c.status === 'HIDDEN' ? 'hidden' : 'visible',
    permalink: null,
    ...(c.reply_count !== undefined && { replyCount: c.reply_count }),
  };
  return comment;
}

/** A permission error on one video's comments is that source's problem, not the connection's. */
const inaccessible = () => new ConnectorError('permanent', 'source_inaccessible');

async function fetchPage(
  log: SkipLog,
  ctx: CallContext,
  endpoint: 'businessCommentList' | 'businessReplyList',
  video: string,
  parent: string | null,
  req: { cursor: string | null; limit: number },
): Promise<Page<NormalizedComment>> {
  const cursor = checkCursor(req.cursor);
  const sourceId = opaqueId(video);
  const { data } = await onPermissionDenied(
    () =>
      tiktokRequest(callOf(ctx), {
        endpoint,
        method: 'GET',
        query: {
          business_id: ctx.externalAccountId,
          video_id: sourceId,
          ...(parent !== null && { comment_id: opaqueId(parent) }),
          max_count: String(Math.max(1, Math.min(req.limit, MAX_PAGE))),
          ...(cursor !== null && { cursor }),
        },
        schema: PAGE_SCHEMA,
      }),
    inaccessible,
  );
  const items = data.comments.flatMap((raw) => toComment(raw, sourceId, parent) ?? []);
  if (items.length < data.comments.length) {
    log('tiktok items skipped', {
      code: 'invalid_item',
      count: data.comments.length - items.length,
    });
  }
  return { items, nextCursor: nextCursor(data) };
}

export const listComments = (
  log: SkipLog,
  ctx: CallContext,
  req: { sourceExternalId: string; cursor: string | null; limit: number },
) => fetchPage(log, ctx, 'businessCommentList', req.sourceExternalId, null, req);

export const listReplies = (
  log: SkipLog,
  ctx: CallContext,
  req: { parent: CommentRef; cursor: string | null; limit: number },
) =>
  fetchPage(log, ctx, 'businessReplyList', req.parent.sourceExternalId, req.parent.externalId, req);

/**
 * V19: TikTok has no get-comment-by-id endpoint, so this scans the video's newest top-level
 * comments (a bounded number of pages). A reply, or a comment further back, reads as null.
 */
export async function getComment(
  log: SkipLog,
  ctx: CallContext,
  ref: CommentRef,
): Promise<NormalizedComment | null> {
  let cursor: string | null = null;
  for (let i = 0; i < GET_COMMENT_MAX_PAGES; i++) {
    const page: Page<NormalizedComment> = await listComments(log, ctx, {
      sourceExternalId: ref.sourceExternalId,
      cursor,
      limit: MAX_PAGE,
    });
    const hit = page.items.find((c) => c.externalId === ref.externalId);
    if (hit) return hit;
    if (page.nextCursor === null) return null;
    cursor = page.nextCursor;
  }
  return null;
}
