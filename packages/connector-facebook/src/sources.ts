// Lists a Page's own recent posts for backfill. Only the cursor is used for
// paging; paging.next is never requested, just mined for an `until` value.
import * as z from 'zod';
import { ConnectorError, type CallContext, type Page, type RecentSource } from '@feedbouncer/connectors';
import { GRAPH_HOST, GRAPH_ID, graphId, graphRequest } from './graph.js';
import { callFor, parseGraphTime, reporting } from './graph-call.js';
import type { FacebookConfig } from './config.js';

const CURSOR = /^[A-Za-z0-9_\-=%.~]{1,2040}$/;
const UNTIL = /^\d{1,12}$/;

export const recentCursor = {
  encode(c: { after: string } | { until: string }): string {
    return 'after' in c ? `a:${c.after}` : `u:${c.until}`;
  },
  decode(c: string | null): { after: string | null; until: string | null } {
    if (c === null) return { after: null, until: null };
    const tag = c.slice(0, 2);
    const v = c.slice(2);
    if (tag === 'a:' && CURSOR.test(v)) return { after: v, until: null };
    if (tag === 'u:' && UNTIL.test(v)) return { after: null, until: v };
    throw new ConnectorError('permanent', 'invalid_cursor');
  },
};

const feedPage = z.object({
  data: z.array(z.unknown()).max(500),
  paging: z
    .object({
      cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
      next: z.string().max(4096).optional(),
    })
    .optional(),
});
const feedItem = z.object({
  id: z.string().max(100),
  created_time: z.string().max(40),
  permalink_url: z.string().max(2048).optional(),
});

/** Only the `until` value of a time-paged `next` link, and only on Graph's own host. */
function untilFrom(next: string | undefined): string | null {
  if (!next) return null;
  let u: URL;
  try {
    u = new URL(next);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== GRAPH_HOST) return null;
  const v = u.searchParams.get('until');
  return v !== null && UNTIL.test(v) ? v : null;
}

export async function listRecentPosts(
  cfg: FacebookConfig,
  nowMs: () => number,
  ctx: CallContext,
  req: { since: Date; cursor: string | null; limit: number },
): Promise<Page<RecentSource>> {
  const { after, until } = recentCursor.decode(req.cursor);
  const r = await reporting(
    ctx,
    nowMs,
    await graphRequest(callFor(cfg, nowMs, ctx), {
      method: 'GET',
      path: [graphId(ctx.externalAccountId), 'feed'],
      query: {
        fields: 'id,created_time,permalink_url',
        limit: String(req.limit),
        since: String(Math.floor(req.since.getTime() / 1000)),
        ...(after ? { after } : {}),
        ...(until ? { until } : {}),
      },
    }),
  );
  const page = feedPage.safeParse(r.body);
  if (!page.success) throw new ConnectorError('permanent', 'invalid_graph_response');
  const items: RecentSource[] = [];
  let lastTime: number | null = null;
  for (const raw of page.data.data) {
    const p = feedItem.safeParse(raw);
    if (!p.success || !GRAPH_ID.test(p.data.id)) continue;
    const t = parseGraphTime(p.data.created_time);
    if (t === null) continue;
    lastTime = t.getTime();
    if (t < req.since) continue; // pinned or backdated old post: skip, keep listing
    const link = p.data.permalink_url;
    items.push({
      externalId: p.data.id,
      createdAt: t,
      permalink: link?.startsWith('https://') ? link : null,
    });
  }
  // The last item decides, so a pinned old post at the top cannot end the listing.
  const passedSince = lastTime !== null && lastTime < req.since.getTime();
  const paging = page.data.paging;
  if (passedSince || !paging?.next) return { items, nextCursor: null };
  const a = paging.cursors?.after;
  if (a && CURSOR.test(a)) return { items, nextCursor: recentCursor.encode({ after: a }) };
  const u = untilFrom(paging.next);
  return { items, nextCursor: u ? recentCursor.encode({ until: u }) : null };
}
