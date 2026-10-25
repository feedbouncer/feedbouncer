// Reads: the account's own posts, the flattened conversation of one post, the direct replies of
// one reply and single replies. Threads reports no author user id, so an author is identified by
// the public handle; the owner's own replies carry the connection's account id instead.
// Every id, time, link and cursor from a response is checked before it is kept. One malformed
// item is dropped and counted; it never fails the page.
import {
  ConnectorError,
  type CommentRef,
  type NormalizedAuthor,
  type NormalizedComment,
  type NormalizedSource,
} from '@feedbouncer/connectors';
import * as z from 'zod';
import { threadsRequest, type ThreadsCall } from './api.js';
import { MEDIA_ID, safeCursor, safePermalink, sanitizeText, threadsTime, username } from './ids.js';

export const REPLY_FIELDS =
  'id,text,username,permalink,timestamp,media_type,has_replies,root_post,replied_to,is_reply,is_reply_owned_by_me,hide_status';

const PAGE_MAX = 100;
const BODY_MAX_CODE_POINTS = 10_000;
const SOURCE_FIELDS = 'id,timestamp,permalink,has_replies';

const ID = z.string().regex(MEDIA_ID);
const REPLY = z.object({
  id: ID,
  text: z.unknown().optional(),
  username: z.unknown().optional(),
  permalink: z.unknown().optional(),
  timestamp: z.string(),
  root_post: z.object({ id: ID }),
  replied_to: z.object({ id: ID }),
  is_reply_owned_by_me: z.boolean().optional(),
  hide_status: z.unknown().optional(),
});
type ParsedReply = z.infer<typeof REPLY>;

/** One item of a Threads reply list, before validation. */
export type RawReply = unknown;

const PAGE = z.object({
  data: z.array(z.unknown()).max(PAGE_MAX),
  paging: z.object({ cursors: z.object({ after: z.unknown().optional() }).optional() }).optional(),
});
type Page = z.infer<typeof PAGE>;

const nextCursor = (p: Page): string | null => safeCursor(p.paging?.cursors?.after);

function parseReply(raw: RawReply): ParsedReply | null {
  const r = REPLY.safeParse(raw);
  return r.success ? r.data : null;
}

function build(
  p: ParsedReply,
  o: { ownAccountExternalId: string; sourceExternalId: string },
): NormalizedComment | null {
  let postedAt: Date;
  try {
    postedAt = threadsTime(p.timestamp);
  } catch {
    return null;
  }
  const handle = username(p.username);
  const author: NormalizedAuthor | null =
    handle === null
      ? null
      : {
          externalId: p.is_reply_owned_by_me === true ? o.ownAccountExternalId : handle,
          displayName: handle,
          profileUrl: `https://www.threads.com/@${handle}`,
        };
  return {
    externalId: p.id,
    sourceExternalId: o.sourceExternalId,
    parentExternalId: p.replied_to.id === p.root_post.id ? null : p.replied_to.id,
    author,
    body: sanitizeText(p.text, BODY_MAX_CODE_POINTS),
    postedAt,
    platformState: p.hide_status === 'HIDDEN' ? 'hidden' : 'visible',
    permalink: safePermalink(p.permalink),
  };
}

/** Null when the item is malformed (counted as skipped_invalid by the caller). */
export function toNormalized(
  raw: RawReply,
  o: { ownAccountExternalId: string; sourceExternalId: string },
): NormalizedComment | null {
  const p = parseReply(raw);
  return p === null ? null : build(p, o);
}

export async function listSources(
  call: ThreadsCall,
  o: { since: Date; cursor: string | null },
): Promise<{ sources: NormalizedSource[]; next: string | null }> {
  const { data } = await threadsRequest(call, {
    endpoint: 'meThreads',
    method: 'GET',
    query: {
      fields: SOURCE_FIELDS,
      since: String(Math.floor(o.since.getTime() / 1000)),
      limit: String(PAGE_MAX),
      ...(o.cursor !== null && { after: o.cursor }),
    },
    schema: PAGE,
  });
  const sources: NormalizedSource[] = [];
  for (const item of data.data) {
    const s = z
      .object({ id: ID, timestamp: z.string(), permalink: z.unknown().optional() })
      .safeParse(item);
    if (!s.success) continue;
    let postedAt: Date;
    try {
      postedAt = threadsTime(s.data.timestamp);
    } catch {
      continue;
    }
    sources.push({
      externalId: s.data.id,
      kind: 'thread',
      permalink: safePermalink(s.data.permalink),
      active: true,
      postedAt,
    });
  }
  return { sources, next: nextCursor(data) };
}

export async function listComments(
  call: ThreadsCall,
  o: { ownAccountExternalId: string; sourceExternalId: string; cursor: string | null },
): Promise<{
  comments: NormalizedComment[];
  next: string | null;
  skippedInvalid: number;
  skippedForeign: number;
}> {
  const { data } = await threadsRequest(call, {
    endpoint: 'conversation',
    id: o.sourceExternalId,
    method: 'GET',
    query: {
      fields: REPLY_FIELDS,
      limit: String(PAGE_MAX),
      ...(o.cursor !== null && { after: o.cursor }),
    },
    schema: PAGE,
  });
  const comments: NormalizedComment[] = [];
  let skippedInvalid = 0;
  let skippedForeign = 0;
  for (const item of data.data) {
    const p = parseReply(item);
    if (p === null) {
      skippedInvalid++;
    } else if (p.root_post.id !== o.sourceExternalId) {
      skippedForeign++;
    } else {
      const c = build(p, o);
      if (c === null) skippedInvalid++;
      else comments.push(c);
    }
  }
  return { comments, next: nextCursor(data), skippedInvalid, skippedForeign };
}

/** Direct replies of one reply (first page); used to find our own published reply again. */
export async function listReplies(
  call: ThreadsCall,
  o: { ownAccountExternalId: string; target: CommentRef },
): Promise<NormalizedComment[]> {
  const { data } = await threadsRequest(call, {
    endpoint: 'replies',
    id: o.target.externalId,
    method: 'GET',
    query: { fields: REPLY_FIELDS, limit: String(PAGE_MAX) },
    schema: PAGE,
  });
  const out: NormalizedComment[] = [];
  for (const item of data.data) {
    const p = parseReply(item);
    if (p === null || p.root_post.id !== o.target.sourceExternalId) continue;
    const c = build(p, { ...o, sourceExternalId: o.target.sourceExternalId });
    if (c !== null) out.push(c);
  }
  return out;
}

const isNotFound = (e: unknown) => e instanceof ConnectorError && e.kind === 'not_found';

/** Null when the reply is gone, malformed or belongs to another post. */
export async function getComment(
  call: ThreadsCall,
  o: { ownAccountExternalId: string; ref: CommentRef },
): Promise<NormalizedComment | null> {
  try {
    const { data } = await threadsRequest(call, {
      endpoint: 'media',
      id: o.ref.externalId,
      method: 'GET',
      query: { fields: REPLY_FIELDS },
      schema: z.unknown(),
    });
    const p = parseReply(data);
    if (p === null || p.id !== o.ref.externalId || p.root_post.id !== o.ref.sourceExternalId) {
      return null;
    }
    return build(p, { ...o, sourceExternalId: o.ref.sourceExternalId });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** The account id that owns a post, or null when the post is gone. */
export async function getPostOwner(call: ThreadsCall, postId: string): Promise<string | null> {
  try {
    const { data } = await threadsRequest(call, {
      endpoint: 'media',
      id: postId,
      method: 'GET',
      query: { fields: 'id,owner' },
      schema: z.object({ owner: z.object({ id: ID }).optional() }),
    });
    return data.owner?.id ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}
