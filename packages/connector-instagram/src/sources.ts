// Lists an account's own recent media for backfill. Pages by `after` cursor
// only; `since` is not documented for /media, so the stop is client-side.
import { ConnectorError, type CallContext, type Page, type RecentSource } from '@feedbouncer/connectors';
import { GRAPH_ID, graphId, recentCursor } from '@feedbouncer/connector-facebook';
import type { InstagramConfig } from './config.js';
import { nextCursorOf, parseIgTime, read } from './comments.js';

const MAX_ITEMS = 500;
const PERMALINK_PREFIX = 'https://www.instagram.com/';

export async function listRecentMedia(
  cfg: InstagramConfig,
  nowMs: () => number,
  ctx: CallContext,
  req: { since: Date; cursor: string | null; limit: number },
): Promise<Page<RecentSource>> {
  const { after, until } = recentCursor.decode(req.cursor);
  if (until !== null) throw new ConnectorError('permanent', 'invalid_cursor');
  const body = await read(
    cfg,
    nowMs,
    ctx,
    [graphId(ctx.externalAccountId), 'media'],
    {
      fields: 'id,timestamp,permalink',
      limit: String(Math.min(100, Math.max(1, Math.trunc(req.limit)))),
      ...(after ? { after } : {}),
    },
    'list_media',
  );
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { data?: unknown }).data)) {
    throw new ConnectorError('permanent', 'invalid_graph_response');
  }
  const edge = body as Record<string, unknown>;
  const data = edge.data as unknown[];
  if (data.length > MAX_ITEMS) throw new ConnectorError('permanent', 'invalid_graph_response');
  const items: RecentSource[] = [];
  let lastTime: number | null = null;
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as { id?: unknown; timestamp?: unknown; permalink?: unknown };
    if (typeof r.id !== 'string' || !GRAPH_ID.test(r.id) || typeof r.timestamp !== 'string') continue;
    const t = parseIgTime(r.timestamp);
    if (t === null) continue;
    lastTime = t.getTime();
    if (t < req.since) continue;
    const permalink =
      typeof r.permalink === 'string' &&
      r.permalink.length <= 2048 &&
      r.permalink.startsWith(PERMALINK_PREFIX)
        ? r.permalink
        : null;
    items.push({ externalId: r.id, createdAt: t, permalink });
  }
  if (lastTime !== null && lastTime < req.since.getTime()) return { items, nextCursor: null };
  const next = nextCursorOf(edge);
  return { items, nextCursor: next ? recentCursor.encode({ after: next }) : null };
}
