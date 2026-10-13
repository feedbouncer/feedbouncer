// Instagram comment reads (Facebook Login). Payloads are validated before use;
// ids are re-checked against GRAPH_ID, paging.next is never followed (only the
// cursor is used) and comment text is returned exactly as received.
import {
  ConnectorError,
  type CallContext,
  type CommentRef,
  type NormalizedComment,
  type Page,
} from '@feedbouncer/connectors';
import { callFor, GRAPH_ID, graphId, graphRequest } from '@feedbouncer/connector-facebook';
import type { InstagramConfig } from './config.js';
import { mapInstagramError } from './errors.js';

export const IG_COMMENT_FIELDS =
  'id,text,timestamp,from,user,username,hidden,parent_id,media{id,permalink}';

const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const CURSOR = /^[A-Za-z0-9=_-]{1,512}$/;
const MAX_ITEMS = 500;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const gid = (v: unknown): string | null => (typeof v === 'string' && GRAPH_ID.test(v) ? v : null);

function permalinkOf(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.host === 'www.instagram.com' ? u.href : null;
  } catch {
    return null;
  }
}

export function toNormalizedIgComment(
  raw: unknown,
  sourceFallback: string | null,
): NormalizedComment | null {
  if (!isObj(raw)) return null;
  const externalId = gid(raw.id);
  if (!externalId) return null;
  const media = isObj(raw.media) ? raw.media : null;
  const sourceExternalId = (media && gid(media.id)) ?? sourceFallback;
  if (!sourceExternalId) return null;
  if (typeof raw.timestamp !== 'string' || raw.timestamp.length > 40) return null;
  // Graph writes "+0000"; normalize the offset so parsing is unambiguous.
  const postedAt = new Date(raw.timestamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!Number.isFinite(postedAt.getTime())) return null;

  const from = isObj(raw.from) ? raw.from : null;
  const user = isObj(raw.user) ? raw.user : null;
  const authorId = gid(from?.id) ?? (from ? null : gid(user?.id));
  let author: NormalizedComment['author'] = null;
  if (authorId) {
    const name =
      typeof from?.username === 'string'
        ? from.username
        : typeof raw.username === 'string'
          ? raw.username
          : null;
    author = {
      externalId: authorId,
      displayName: name === null ? null : name.slice(0, 200),
      profileUrl:
        name !== null && USERNAME.test(name) ? `https://www.instagram.com/${name}/` : null,
    };
  }
  const parent = gid(raw.parent_id);
  return {
    externalId,
    sourceExternalId,
    parentExternalId: parent && parent !== externalId ? parent : null,
    author,
    body: typeof raw.text === 'string' ? raw.text.replaceAll('\u0000', '�') : '',
    postedAt,
    platformState: raw.hidden === true ? 'hidden' : 'visible',
    permalink: permalinkOf(media?.permalink),
  };
}

async function read(
  cfg: InstagramConfig,
  nowMs: () => number,
  ctx: CallContext,
  path: string[],
  query: Record<string, string>,
): Promise<unknown> {
  try {
    const r = await graphRequest(callFor(cfg.meta, nowMs, ctx), { method: 'GET', path, query });
    if (r.usage.throttledForMs) {
      await ctx.reportQuota({ remaining: 0, resetAt: new Date(nowMs() + r.usage.throttledForMs) });
    }
    return r.body;
  } catch (e) {
    if (e instanceof ConnectorError) {
      const mapped = mapInstagramError(e, 'read');
      if ('throw' in mapped) throw mapped.throw;
    }
    throw e;
  }
}

export async function getComment(
  cfg: InstagramConfig,
  nowMs: () => number,
  ctx: CallContext,
  ref: CommentRef,
): Promise<NormalizedComment | null> {
  let body: unknown;
  try {
    body = await read(cfg, nowMs, ctx, [graphId(ref.externalId)], { fields: IG_COMMENT_FIELDS });
  } catch (e) {
    if (e instanceof ConnectorError && e.kind === 'not_found') return null;
    throw e;
  }
  const c = toNormalizedIgComment(body, ref.sourceExternalId);
  if (!c) throw new ConnectorError('permanent', 'invalid_graph_response');
  return c;
}

async function list(
  cfg: InstagramConfig,
  nowMs: () => number,
  ctx: CallContext,
  parentId: string,
  segment: 'comments' | 'replies',
  sourceFallback: string | null,
  req: { cursor: string | null; limit: number },
): Promise<Page<NormalizedComment>> {
  const id = graphId(parentId);
  if (req.cursor !== null && !CURSOR.test(req.cursor)) {
    throw new ConnectorError('permanent', 'invalid_cursor');
  }
  const limit = Math.min(100, Math.max(1, Number.isFinite(req.limit) ? Math.trunc(req.limit) : 25));
  const body = await read(cfg, nowMs, ctx, [id, segment], {
    fields: IG_COMMENT_FIELDS,
    limit: String(limit),
    ...(req.cursor ? { after: req.cursor } : {}),
  });
  if (!isObj(body) || !Array.isArray(body.data) || body.data.length > MAX_ITEMS) {
    throw new ConnectorError('permanent', 'invalid_graph_response');
  }
  const items = (body.data as unknown[])
    .map((x) => toNormalizedIgComment(x, sourceFallback))
    .filter((x): x is NormalizedComment => x !== null);
  const paging = isObj(body.paging) ? body.paging : null;
  const cursors = paging && isObj(paging.cursors) ? paging.cursors : null;
  const after =
    typeof cursors?.after === 'string' && CURSOR.test(cursors.after) ? cursors.after : null;
  return { items, nextCursor: paging?.next ? after : null };
}

export const listComments = (
  cfg: InstagramConfig,
  nowMs: () => number,
  ctx: CallContext,
  req: { sourceExternalId: string; cursor: string | null; limit: number },
): Promise<Page<NormalizedComment>> =>
  list(cfg, nowMs, ctx, req.sourceExternalId, 'comments', req.sourceExternalId, req);

export const listReplies = (
  cfg: InstagramConfig,
  nowMs: () => number,
  ctx: CallContext,
  req: { parent: CommentRef; cursor: string | null; limit: number },
): Promise<Page<NormalizedComment>> =>
  list(cfg, nowMs, ctx, req.parent.externalId, 'replies', req.parent.sourceExternalId, req);
