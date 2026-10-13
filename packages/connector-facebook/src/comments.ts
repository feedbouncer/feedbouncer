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
import { GRAPH_ID, graphId, graphRequest, type GraphCall } from './graph.js';

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

// Graph returns "2026-10-13T09:00:00+0000"; normalize the offset for unambiguous parsing.
const parseGraphTime = (s: string): Date => new Date(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

export function toNormalizedComment(
  raw: unknown,
  sourceExternalId: string,
): NormalizedComment | null {
  const r = graphComment.safeParse(raw);
  if (!r.success) return null;
  const c = r.data;
  const postedAt = parseGraphTime(c.created_time);
  if (!Number.isFinite(postedAt.getTime())) return null;
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

const callFor = (cfg: FacebookConfig, nowMs: () => number, ctx: CallContext): GraphCall => ({
  http: ctx.http,
  signal: ctx.signal,
  version: cfg.graphVersion,
  appSecret: cfg.appSecret,
  token: ctx.accessToken,
  nowMs,
});

async function reporting<T extends { usage: { throttledForMs: number | null } }>(
  ctx: CallContext,
  nowMs: () => number,
  r: T,
): Promise<T> {
  if (r.usage.throttledForMs) {
    await ctx.reportQuota({ remaining: 0, resetAt: new Date(nowMs() + r.usage.throttledForMs) });
  }
  return r;
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
  req: { sourceExternalId: string; cursor: string | null; limit: number },
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
