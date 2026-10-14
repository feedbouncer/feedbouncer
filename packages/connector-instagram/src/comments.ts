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
import { mapInstagramError, type IgOp } from './errors.js';

export const IG_COMMENT_FIELDS =
  'id,text,timestamp,from,user,username,hidden,parent_id,media{id,permalink}';

const INLINE_REPLIES = 50;

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
    const plain = u.username === '' && u.password === '';
    return plain && u.protocol === 'https:' && u.host === 'www.instagram.com' ? u.href : null;
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
  // Graph returns `user` only when the account itself wrote the comment, and
  // its id is the account id; `from.id` may be a scoped id. Prefer `user.id` so
  // own-account detection compares like with like. UNVERIFIED (V9 in the README).
  const authorId = gid(user?.id) ?? gid(from?.id);
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
  op: IgOp = 'read',
): Promise<unknown> {
  try {
    const r = await graphRequest(callFor(cfg.meta, nowMs, ctx), { method: 'GET', path, query });
    if (r.usage.throttledForMs) {
      await ctx.reportQuota({ remaining: 0, resetAt: new Date(nowMs() + r.usage.throttledForMs) });
    }
    return r.body;
  } catch (e) {
    if (e instanceof ConnectorError) {
      const mapped = mapInstagramError(e, op);
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

/** The `after` cursor of a Graph edge when it has a further page; `paging.next` is never followed. */
function nextCursorOf(edge: Record<string, unknown>): string | null {
  const paging = isObj(edge.paging) ? edge.paging : null;
  const cursors = paging && isObj(paging.cursors) ? paging.cursors : null;
  const after =
    typeof cursors?.after === 'string' && CURSOR.test(cursors.after) ? cursors.after : null;
  return paging?.next ? after : null;
}

/**
 * Position inside a comments page when a call stops early: re-read the page at
 * `after` and continue past top-level comment `s`, the last one emitted; with
 * `r` the replies of `s` continue from reply cursor `r`. Anchoring on the
 * comment id keeps the position correct when comments are deleted in between.
 * Opaque to callers, validated on the way in.
 */
interface Resume {
  a: string | null;
  s: string | null;
  r: string | null;
}
const RESUME_PREFIX = 'ir_';
const encodeResume = (s: Resume): string =>
  RESUME_PREFIX + Buffer.from(JSON.stringify(s)).toString('base64url');

function decodeResume(cursor: string | null): Resume {
  if (cursor?.startsWith(RESUME_PREFIX) && cursor.length <= 2048) {
    try {
      const s: unknown = JSON.parse(
        Buffer.from(cursor.slice(RESUME_PREFIX.length), 'base64url').toString(),
      );
      if (isObj(s)) {
        const ok = (v: unknown) => v === null || (typeof v === 'string' && CURSOR.test(v));
        if (ok(s.a) && ok(s.r) && (s.s === null || gid(s.s)) && (s.r === null || s.s !== null)) {
          return { a: s.a as string | null, s: s.s as string | null, r: s.r as string | null };
        }
      }
    } catch {
      /* not ours: treated as a plain Graph cursor below */
    }
  }
  if (cursor !== null && !CURSOR.test(cursor)) {
    throw new ConnectorError('permanent', 'invalid_cursor');
  }
  return { a: cursor, s: null, r: null };
}

const withParent = (c: NormalizedComment, parent: string): NormalizedComment => ({
  ...c,
  parentExternalId: c.parentExternalId ?? parent,
});

async function list(
  cfg: InstagramConfig,
  nowMs: () => number,
  ctx: CallContext,
  parentId: string,
  segment: 'comments' | 'replies',
  sourceFallback: string | null,
  req: { cursor: string | null; limit: number; includeReplies?: boolean },
  op: IgOp,
): Promise<Page<NormalizedComment>> {
  const id = graphId(parentId);
  const inline = req.includeReplies === true && segment === 'comments';
  const resume = inline ? decodeResume(req.cursor) : { a: req.cursor, s: null, r: null };
  if (!inline && req.cursor !== null && !CURSOR.test(req.cursor)) {
    throw new ConnectorError('permanent', 'invalid_cursor');
  }
  const limit = Math.min(100, Math.max(1, Number.isFinite(req.limit) ? Math.trunc(req.limit) : 25));
  // One Graph request per call, so one budget acquire per request: a comment's
  // further reply pages are carried in the cursor, never fetched in a loop.
  if (resume.s !== null && resume.r !== null) {
    const more = await list(
      cfg,
      nowMs,
      ctx,
      resume.s,
      'replies',
      sourceFallback,
      {
        cursor: resume.r,
        limit: INLINE_REPLIES,
      },
      op,
    );
    const parent = resume.s;
    const items = more.items.map((c) => withParent(c, parent));
    return { items, nextCursor: encodeResume({ a: resume.a, s: parent, r: more.nextCursor }) };
  }
  const body = await read(
    cfg,
    nowMs,
    ctx,
    [id, segment],
    {
      fields: inline
        ? `${IG_COMMENT_FIELDS},replies.limit(${INLINE_REPLIES}){${IG_COMMENT_FIELDS}}`
        : IG_COMMENT_FIELDS,
      limit: String(limit),
      ...(resume.a ? { after: resume.a } : {}),
    },
    op,
  );
  if (!isObj(body) || !Array.isArray(body.data) || body.data.length > MAX_ITEMS) {
    throw new ConnectorError('permanent', 'invalid_graph_response');
  }
  const data = body.data as unknown[];
  const items: NormalizedComment[] = [];
  // When the anchor comment is gone, re-read the whole page: duplicates are harmless, gaps are not.
  const anchor = data.findIndex((raw) => isObj(raw) && raw.id === resume.s);
  let lastEmitted = resume.s;
  for (let i = anchor + 1; i < data.length; i++) {
    const raw = data[i];
    // A comment brings at most 1 + INLINE_REPLIES items; keep the page under the runtime cap.
    if (items.length > 0 && items.length + 1 + INLINE_REPLIES > MAX_ITEMS) {
      return { items, nextCursor: encodeResume({ a: resume.a, s: lastEmitted, r: null }) };
    }
    const top = toNormalizedIgComment(raw, sourceFallback);
    if (!top) continue;
    items.push(top);
    lastEmitted = top.externalId;
    const edge = inline && isObj(raw) && isObj(raw.replies) ? raw.replies : null;
    if (!edge || !Array.isArray(edge.data)) continue;
    for (const r of edge.data.slice(0, INLINE_REPLIES)) {
      const c = toNormalizedIgComment(r, top.sourceExternalId);
      if (c) items.push(withParent(c, top.externalId));
    }
    const more = nextCursorOf(edge);
    if (more) {
      return { items, nextCursor: encodeResume({ a: resume.a, s: top.externalId, r: more }) };
    }
  }
  return { items, nextCursor: nextCursorOf(body) };
}

export const listComments = (
  cfg: InstagramConfig,
  nowMs: () => number,
  ctx: CallContext,
  req: {
    sourceExternalId: string;
    cursor: string | null;
    limit: number;
    includeReplies?: boolean;
  },
): Promise<Page<NormalizedComment>> =>
  list(cfg, nowMs, ctx, req.sourceExternalId, 'comments', req.sourceExternalId, req, 'list_source');

export const listReplies = (
  cfg: InstagramConfig,
  nowMs: () => number,
  ctx: CallContext,
  req: { parent: CommentRef; cursor: string | null; limit: number },
): Promise<Page<NormalizedComment>> =>
  list(cfg, nowMs, ctx, req.parent.externalId, 'replies', req.parent.sourceExternalId, req, 'read');
