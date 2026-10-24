import {
  ConnectorError,
  type CallContext,
  type CommentRef,
  type ConnectionCommentsPage,
  type NormalizedComment,
  type NormalizedSource,
} from '@feedbouncer/connectors';
import {
  OPAQUE_ID,
  adVideoPermalink,
  numericId,
  sanitizeText,
  tiktokRequest,
  tiktokTime,
} from '@feedbouncer/tiktok-business-api';
import * as z from 'zod';
import { callOf, scoped, type SkipLog } from './call.js';

const id = z.string().regex(OPAQUE_ID);
/** One element of `comments`. V13 corrections land here. */
const COMMENT_SCHEMA = z.object({
  comment_id: id,
  ad_id: id,
  tiktok_item_id: id,
  original_comment_id: id.optional(),
  content: z.string().max(40_000),
  create_time: z.unknown(),
  comment_status: z.string().max(40).optional(),
  user_id: id,
  user_name: z.string().max(500).optional(),
});
const PAGE_SCHEMA = z.object({
  comments: z.array(z.unknown()).max(500),
  page_info: z.object({
    page: z.number().int().min(1),
    total_page: z.number().int().min(0),
  }),
});

const DAY_MS = 86_400_000;
const MAX_WINDOW_DAYS = 30;
const MAX_PAGE_NO = 100_000;
const MAX_PAGE_SIZE = 100;
const invalidRequest = () => new ConnectorError('permanent', 'invalid_request');
const inRange = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max;
const day = (d: Date) => d.toISOString().slice(0, 10);

export interface AdComment {
  readonly comment: NormalizedComment;
  readonly adId: string;
  readonly itemId: string;
}

function toAdComment(raw: unknown): AdComment | null {
  const r = COMMENT_SCHEMA.safeParse(raw);
  if (!r.success) return null;
  const c = r.data;
  try {
    const adId = numericId(c.ad_id);
    const itemId = numericId(c.tiktok_item_id);
    return {
      adId,
      itemId,
      comment: {
        externalId: c.comment_id,
        sourceExternalId: adId,
        parentExternalId: c.original_comment_id ?? null,
        author: {
          externalId: c.user_id,
          displayName: c.user_name === undefined ? null : sanitizeText(c.user_name, 200),
          profileUrl: null,
        },
        body: sanitizeText(c.content, 10_000),
        postedAt: tiktokTime(c.create_time),
        platformState: c.comment_status === 'HIDDEN' ? 'hidden' : 'visible',
        permalink: null,
      },
    };
  } catch {
    return null;
  }
}

async function fetchPage(
  log: SkipLog,
  ctx: CallContext,
  q: {
    since: Date;
    until: Date;
    page: number;
    pageSize: number;
    searchField: 'ADVERTISER_ID' | 'COMMENT_ID';
    searchValue: string;
  },
) {
  const span = q.until.getTime() - q.since.getTime();
  if (
    !(span >= 0 && span <= MAX_WINDOW_DAYS * DAY_MS) ||
    !inRange(q.page, MAX_PAGE_NO) ||
    !inRange(q.pageSize, MAX_PAGE_SIZE)
  ) {
    throw invalidRequest();
  }
  const { data } = await scoped(() =>
    tiktokRequest(callOf(ctx), {
      endpoint: 'adCommentList',
      method: 'GET',
      query: {
        advertiser_id: ctx.externalAccountId,
        search_field: q.searchField,
        search_value: q.searchValue,
        start_time: day(q.since),
        end_time: day(q.until),
        sort_field: 'CREATE_TIME',
        sort_type: 'DESC',
        comment_type: '["ALL"]',
        page: String(q.page),
        page_size: String(q.pageSize),
      },
      schema: PAGE_SCHEMA,
    }),
  );
  const items = data.comments.flatMap((raw) => toAdComment(raw) ?? []);
  if (items.length < data.comments.length) {
    log('tiktok items skipped', {
      code: 'invalid_item',
      count: data.comments.length - items.length,
    });
  }
  return { items, hasMore: data.page_info.page < data.page_info.total_page };
}

export async function listConnectionComments(
  log: SkipLog,
  ctx: CallContext,
  req: { since: Date; until: Date; page: number; pageSize: number },
): Promise<ConnectionCommentsPage> {
  const { items, hasMore } = await fetchPage(log, ctx, {
    ...req,
    searchField: 'ADVERTISER_ID',
    searchValue: ctx.externalAccountId,
  });
  const sources = new Map<string, NormalizedSource>();
  for (const { adId, itemId } of items) {
    if (sources.has(adId)) continue;
    sources.set(adId, {
      externalId: adId,
      kind: 'ad_post',
      permalink: adVideoPermalink(itemId),
      active: true,
    });
  }
  return { items: items.map((i) => i.comment), sources: [...sources.values()], hasMore };
}

/**
 * V19: finds one comment by id within the last 30 days (the list endpoint is windowed and
 * `ActionRequest` carries no creation time). Older comments read as not found.
 */
export async function findComment(
  log: SkipLog,
  now: () => number,
  ctx: CallContext,
  commentId: string,
): Promise<AdComment | null> {
  const until = new Date(now());
  const since = new Date(until.getTime() - MAX_WINDOW_DAYS * DAY_MS);
  const { items } = await fetchPage(log, ctx, {
    since,
    until,
    page: 1,
    pageSize: MAX_PAGE_SIZE,
    searchField: 'COMMENT_ID',
    searchValue: commentId,
  });
  return items.find((i) => i.comment.externalId === commentId) ?? null;
}

export async function getComment(
  log: SkipLog,
  now: () => number,
  ctx: CallContext,
  ref: CommentRef,
): Promise<NormalizedComment | null> {
  return (await findComment(log, now, ctx, ref.externalId))?.comment ?? null;
}
