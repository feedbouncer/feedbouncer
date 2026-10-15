// Comment reads. Graph payloads are validated before use; ids are re-checked
// against GRAPH_ID and paging.next is never followed (only the cursor is used).
import {
  ConnectorError,
  type CallContext,
  type CommentRef,
  type NormalizedComment,
  type Page,
} from '@feedbouncer/connectors';
import * as z from 'zod';
import type { FacebookConfig } from './config.js';
import { GRAPH_ID, graphId, graphRequest } from './graph.js';
import { callFor, parseGraphTime, reporting } from './graph-call.js';

export const COMMENT_FIELDS =
  'id,message,created_time,from{id,name},parent{id},is_hidden,permalink_url';

const graphComment = z.object({
  id: z.string().regex(GRAPH_ID),
  message: z.string().max(100_000).optional(),
  created_time: z.string().max(40),
  from: z
    .object({ id: z.string().regex(GRAPH_ID), name: z.string().max(500).optional() })
    .optional(),
  parent: z.object({ id: z.string().regex(GRAPH_ID) }).optional(),
  is_hidden: z.boolean().optional(),
  permalink_url: z.string().max(2048).optional(),
});

export function toNormalizedComment(
  raw: unknown,
  sourceExternalId: string,
): NormalizedComment | null {
  const r = graphComment.safeParse(raw);
  if (!r.success) return null;
  const c = r.data;
  const postedAt = parseGraphTime(c.created_time);
  if (postedAt === null) return null;
  return {
    externalId: c.id,
    sourceExternalId,
    parentExternalId: c.parent && c.parent.id !== c.id ? c.parent.id : null,
    author: c.from
      ? { externalId: c.from.id, displayName: c.from.name ?? null, profileUrl: null }
      : null,
    body: c.message ?? '',
    postedAt,
    platformState: c.is_hidden ? 'hidden' : 'visible',
    permalink: c.permalink_url?.startsWith('https://') ? c.permalink_url : null,
  };
}

export async function getComment(
  cfg: FacebookConfig,
  nowMs: () => number,
  ctx: CallContext,
  ref: CommentRef,
): Promise<NormalizedComment | null> {
  try {
    const r = await reporting(
      ctx,
      nowMs,
      await graphRequest(callFor(cfg, nowMs, ctx), {
        method: 'GET',
        path: [graphId(ref.externalId)],
        query: { fields: COMMENT_FIELDS },
      }),
    );
    const c = toNormalizedComment(r.body, ref.sourceExternalId);
    if (!c) throw new ConnectorError('permanent', 'invalid_graph_response');
    return c;
  } catch (err) {
    if (err instanceof ConnectorError && err.kind === 'not_found') return null;
    throw err;
  }
}

const listPage = z.object({
  data: z.array(z.unknown()).max(500),
  paging: z
    .object({
      cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});

export async function listComments(
  cfg: FacebookConfig,
  nowMs: () => number,
  ctx: CallContext,
  // `includeReplies` is accepted and ignored: filter=stream already returns replies.
  req: { sourceExternalId: string; cursor: string | null; limit: number; includeReplies?: boolean },
): Promise<Page<NormalizedComment>> {
  const r = await reporting(
    ctx,
    nowMs,
    await graphRequest(callFor(cfg, nowMs, ctx), {
      method: 'GET',
      path: [graphId(req.sourceExternalId), 'comments'],
      query: {
        fields: COMMENT_FIELDS,
        filter: 'stream',
        order: 'reverse_chronological',
        limit: String(req.limit),
        ...(req.cursor ? { after: req.cursor } : {}),
      },
    }),
  );
  const page = listPage.safeParse(r.body);
  if (!page.success) throw new ConnectorError('permanent', 'invalid_graph_response');
  const items = page.data.data
    .map((x) => toNormalizedComment(x, req.sourceExternalId))
    .filter((x): x is NormalizedComment => x !== null);
  return {
    items,
    nextCursor: page.data.paging?.next ? (page.data.paging.cursors?.after ?? null) : null,
  };
}
