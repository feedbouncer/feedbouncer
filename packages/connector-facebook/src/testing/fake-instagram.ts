// Instagram (Facebook Login) half of the FakeGraph: accounts linked to Pages,
// media, comments, replies and private replies. State lives in `IgState`; the
// FakeGraph owns one and delegates Instagram-addressed routes to `routeInstagram`
// after its own token and appsecret_proof checks have passed.
import { PRIVATE_REPLY_WINDOW_MS } from '@feedbouncer/connectors';

/** Placeholder Graph codes until verified against a live account; change them here only. */
export const FAKE_IG_ERRORS = {
  replyToHidden: { code: 100, subcode: 2534023 },
  privateReplyNested: { code: 100, subcode: 2534024 },
  privateReplyAlreadySent: { code: 10900, subcode: null },
  privateReplyWindowClosed: { code: 10, subcode: 2018278 },
  accountRestricted: { code: 25, subcode: 2207050 },
} as const;

/** Instagram scopes a user is treated as having granted unless a test says otherwise. */
export const FAKE_IG_SCOPES = [
  'instagram_basic',
  'instagram_manage_comments',
  'instagram_manage_messages',
] as const;

interface IgAccount {
  id: string;
  pageId: string;
  username: string;
}
interface IgMedia {
  id: string;
  igUserId: string;
  live: boolean;
}
interface IgComment {
  id: string;
  igUserId: string;
  mediaId: string;
  parentId: string | null;
  authorId: string;
  /** What Graph reports as `from.id`; may differ from authorId (app-scoped id). */
  fromId: string;
  username: string;
  text: string;
  createdAtMs: number;
  hidden: boolean;
  deleted: boolean;
  privateReplies: string[];
}

export interface IgState {
  seq: number;
  accounts: Map<string, IgAccount>;
  byPage: Map<string, string>; // page id -> ig user id
  media: Map<string, IgMedia>;
  comments: Map<string, IgComment>;
  granted: Map<string, string[]>; // user id -> explicit permission list
}

export const createIgState = (): IgState => ({
  seq: 0,
  accounts: new Map(),
  byPage: new Map(),
  media: new Map(),
  comments: new Map(),
  granted: new Map(),
});

/** What the Instagram routes need from the FakeGraph that owns them. */
export interface IgHost {
  clock(): number;
  graphTime(ms: number): string;
  reply(status: number, body: unknown): Response;
  error(code: number, subcode?: number): Response;
  /** The user who owns the Page, to evaluate their granted permissions. */
  pageOwner(pageId: string): string | undefined;
  permissionGranted(userId: string, permission: string): boolean;
}

const pad = (n: number) => String(n).padStart(14, '0');
const igId = (s: IgState) => `178${pad(++s.seq)}`;
const mediaId = (s: IgState) => `179${pad(++s.seq)}`;

export function addInstagramAccount(
  s: IgState,
  pageId: string,
  opts: { username?: string } = {},
): { igUserId: string } {
  if (s.byPage.has(pageId)) throw new Error('page already has an instagram account');
  const id = igId(s);
  s.accounts.set(id, { id, pageId, username: opts.username ?? `account${s.seq}` });
  s.byPage.set(pageId, id);
  return { igUserId: id };
}

/** The `instagram_business_account` field of a Page, or undefined when not linked. */
export function linkedAccount(
  s: IgState,
  pageId: string,
): { id: string; username: string } | undefined {
  const a = s.accounts.get(s.byPage.get(pageId) ?? '');
  return a && { id: a.id, username: a.username };
}

export interface AddIgCommentOptions {
  mediaId?: string;
  authorId?: string;
  /** The `from.id` Graph reports, when it differs from authorId (defaults to authorId). */
  fromId?: string;
  username?: string;
  parentId?: string;
  text?: string;
  createdAtMs?: number;
  live?: boolean;
}

export function addIgComment(
  s: IgState,
  now: number,
  igUserId: string,
  o: AddIgCommentOptions = {},
): { mediaId: string; commentId: string } {
  const account = s.accounts.get(igUserId);
  if (!account) throw new Error('unknown instagram account');
  const parent = o.parentId ? s.comments.get(o.parentId) : undefined;
  if (o.parentId && !parent) throw new Error('unknown parent comment');
  const mid = o.mediaId ?? parent?.mediaId ?? mediaId(s);
  if (!s.media.has(mid)) s.media.set(mid, { id: mid, igUserId, live: o.live ?? false });
  const id = igId(s);
  const authorId = o.authorId ?? igId(s);
  s.comments.set(id, {
    id,
    igUserId,
    mediaId: mid,
    parentId: o.parentId ?? null,
    authorId,
    fromId: o.fromId ?? authorId,
    username: o.username ?? (authorId === igUserId ? account.username : `user${s.seq}`),
    text: o.text ?? 'hello',
    createdAtMs: o.createdAtMs ?? now,
    hidden: false,
    deleted: false,
    privateReplies: [],
  });
  return { mediaId: mid, commentId: id };
}

function comment(s: IgState, id: string): IgComment {
  const c = s.comments.get(id);
  if (!c) throw new Error('unknown instagram comment');
  return c;
}

export const igState = (s: IgState, id: string): 'visible' | 'hidden' | 'deleted' => {
  const c = comment(s, id);
  return c.deleted ? 'deleted' : c.hidden ? 'hidden' : 'visible';
};
export const igReplies = (s: IgState, id: string) =>
  [...s.comments.values()]
    .filter((c) => c.parentId === id && !c.deleted)
    .map((c) => ({ id: c.id, text: c.text, fromId: c.authorId }));
export const igPrivateReplies = (s: IgState, id: string): readonly string[] => [
  ...comment(s, id).privateReplies,
];
export const ownerHides = (s: IgState, id: string): void => {
  comment(s, id).hidden = true;
};
export const ownerDeletes = (s: IgState, id: string): void => {
  comment(s, id).deleted = true;
};

export interface IgDeliveryComment {
  commentId: string;
  mediaId?: string;
  parentId?: string;
  text?: string;
  authorId?: string;
  username?: string;
  productType?: string;
}

export function instagramDeliveryBody(
  s: IgState,
  nowMs: number,
  igUserId: string,
  comments: readonly IgDeliveryComment[],
  timeUnit: 's' | 'ms',
): unknown {
  const time = timeUnit === 'ms' ? nowMs : Math.floor(nowMs / 1000);
  return {
    object: 'instagram',
    entry: [
      {
        id: igUserId,
        time,
        changes: comments.map((c) => ({
          field: 'comments',
          value: {
            from: { id: c.authorId ?? igId(s), username: c.username ?? 'someone' },
            comment_id: c.commentId,
            ...(c.parentId ? { parent_id: c.parentId } : {}),
            ...(c.text !== undefined ? { text: c.text } : {}),
            media: { id: c.mediaId ?? mediaId(s), media_product_type: c.productType ?? 'FEED' },
          },
        })),
      },
    ],
  };
}

function page<T>(items: T[], query: URLSearchParams): { slice: T[]; more: boolean; after: string } {
  const limit = Number(query.get('limit') ?? '25');
  const size = Number.isInteger(limit) && limit > 0 ? limit : 25;
  const after = query.get('after') ?? '';
  const start = /^c\d{1,9}$/.test(after) ? Number(after.slice(1)) : 0;
  const end = start + size;
  return { slice: items.slice(start, end), more: end < items.length, after: `c${end}` };
}

/**
 * Handles a request whose first path segment is an Instagram id. Returns null when
 * it is not one, so the caller can continue with Facebook routing.
 */
export function routeInstagram(
  s: IgState,
  host: IgHost,
  method: string,
  path: string[],
  query: URLSearchParams,
  form: URLSearchParams,
  json: unknown,
  who: { kind: 'user' | 'page'; id: string },
): Response | null {
  const [first, second] = path;
  if (!first) return null;
  const account = s.accounts.get(first);
  const target = s.comments.get(first);
  const media = s.media.get(first);
  if (!account && !target && !media) return null;

  const missing = () => host.error(100, 33);
  const bad = () => host.error(100);
  const denied = () => host.error(200);
  const accountId = account?.id ?? target?.igUserId ?? media?.igUserId ?? '';
  const owner = s.accounts.get(accountId);
  if (!owner || who.kind !== 'page' || who.id !== owner.pageId) return denied();

  const view = (c: IgComment) => ({
    id: c.id,
    text: c.text,
    timestamp: host.graphTime(c.createdAtMs),
    from: { id: c.fromId, username: c.username },
    // Graph adds `user` only when the account itself wrote the comment.
    ...(c.authorId === c.igUserId ? { user: { id: c.authorId } } : {}),
    username: c.username,
    hidden: c.hidden,
    ...(c.parentId ? { parent_id: c.parentId } : {}),
    media: { id: c.mediaId, permalink: `https://www.instagram.com/p/${c.mediaId}/` },
  });
  const list = (items: IgComment[], inlineReplies = false) => {
    const p = page(items, query);
    const withReplies = (c: IgComment) => ({
      ...view(c),
      replies: (() => {
        const all = [...s.comments.values()].filter((r) => r.parentId === c.id && !r.deleted);
        return {
          data: all.slice(0, 50).map(view),
          ...(all.length > 50
            ? {
                paging: {
                  cursors: { after: 'c50' },
                  next: `https://graph.facebook.com/${c.id}/replies?after=c50`,
                },
              }
            : {}),
        };
      })(),
    });
    return host.reply(200, {
      data: p.slice.map(inlineReplies ? withReplies : view),
      paging: {
        cursors: { after: p.after },
        ...(p.more ? { next: `https://graph.facebook.com/${first}/next?after=${p.after}` } : {}),
      },
    });
  };

  if (account) {
    if (path.length !== 2 || second !== 'messages' || method !== 'POST') return missing();
    const body = json as {
      recipient?: { comment_id?: unknown };
      message?: { text?: unknown };
    } | null;
    const cid = body?.recipient?.comment_id;
    const text = body?.message?.text;
    if (typeof cid !== 'string' || typeof text !== 'string') return bad();
    const c = s.comments.get(cid);
    if (!c || c.deleted || c.igUserId !== account.id) return missing();
    const userId = host.pageOwner(account.pageId);
    if (!userId || !host.permissionGranted(userId, 'instagram_manage_messages')) {
      return host.error(10);
    }
    const e = FAKE_IG_ERRORS;
    if (c.parentId !== null)
      return host.error(e.privateReplyNested.code, e.privateReplyNested.subcode);
    if (host.clock() - c.createdAtMs >= PRIVATE_REPLY_WINDOW_MS) {
      return host.error(e.privateReplyWindowClosed.code, e.privateReplyWindowClosed.subcode);
    }
    if (c.privateReplies.length > 0) return host.error(e.privateReplyAlreadySent.code);
    c.privateReplies.push(text);
    return host.reply(200, {
      recipient_id: c.authorId,
      message_id: `m_${String(++s.seq).padStart(12, '0')}`,
    });
  }

  if (media) {
    if (path.length !== 2 || second !== 'comments' || method !== 'GET') return missing();
    return list(
      [...s.comments.values()].filter((c) => c.mediaId === media.id && !c.parentId && !c.deleted),
      (query.get('fields') ?? '').includes('replies'),
    );
  }

  const c = target!;
  if (c.deleted) return missing();
  if (path.length === 1) {
    if (method === 'GET') return host.reply(200, view(c));
    if (method === 'POST') {
      const hide = form.get('hide');
      if (hide !== 'true' && hide !== 'false') return bad();
      if (c.authorId !== c.igUserId) c.hidden = hide === 'true';
      return host.reply(200, { success: true });
    }
    if (method === 'DELETE') {
      c.deleted = true;
      return host.reply(200, { success: true });
    }
    return bad();
  }
  if (path.length === 2 && second === 'replies') {
    if (method === 'GET') {
      return list([...s.comments.values()].filter((r) => r.parentId === c.id && !r.deleted));
    }
    if (method === 'POST') {
      const message = form.get('message');
      if (!message) return bad();
      const top = c.parentId ? (s.comments.get(c.parentId) ?? c) : c;
      if (c.hidden || top.hidden) {
        return host.error(FAKE_IG_ERRORS.replyToHidden.code, FAKE_IG_ERRORS.replyToHidden.subcode);
      }
      const r = addIgComment(s, host.clock(), c.igUserId, {
        mediaId: top.mediaId,
        parentId: top.id,
        authorId: c.igUserId,
        text: message,
      });
      return host.reply(200, { id: r.commentId });
    }
  }
  return missing();
}
