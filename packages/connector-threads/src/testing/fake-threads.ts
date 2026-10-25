// Stateful fake of the Threads API (graph.threads.net) as a `fetch` for
// `createSafeHttp({ fetch })`, plus signed webhook deliveries. It encodes the
// connector's primary assumptions; the ones marked "assumed" still need checking
// against a real app.

import { createHmac } from 'node:crypto';
import type { ThreadsEndpoint } from '../api.js';

const ALL_SCOPES = [
  'threads_basic',
  'threads_read_replies',
  'threads_manage_replies',
  'threads_content_publish',
];
const FIRST_ID = 17_840_000_000_000_000n;
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const REPLY_QUOTA_TOTAL = 1000;
const LONG_LIVED_TTL_SEC = 60 * 24 * 3600;
const SHORT_LIVED_TTL_SEC = 3600;
/** Assumed: managing a nested reply is rejected with an 2207xxx subcode. */
const NESTED_MANAGE_SUBCODE = 2207057;
const QUOTA_SUBCODE = 2207051;

type Obj = Record<string, unknown>;
type HideStatus = 'NOT_HUSHED' | 'HIDDEN' | 'UNHUSHED';

interface User {
  id: string;
  username: string;
  scopes: string[];
  quotaUsed: number;
}
interface Media {
  id: string;
  /** null for a root post. */
  parentId: string | null;
  rootId: string;
  authorId: string | null;
  username: string | null;
  text: string;
  mediaType: string;
  at: Date;
  hide: HideStatus;
  deleted: boolean;
}
interface Token {
  userId: string;
  expiresAt: Date;
  revoked: boolean;
}
interface Failure {
  code?: number;
  subcode?: number;
  httpStatus?: number;
  times: number;
}
export interface FakeThreadsCall {
  endpoint: ThreadsEndpoint;
  id?: string;
  query: Record<string, string>;
  form: Record<string, string>;
}

const graphError = (httpStatus: number, code?: number, subcode?: number): Response =>
  Response.json(
    {
      error: {
        message: 'fake error',
        type: 'OAuthException',
        ...(code !== undefined && { code }),
        ...(subcode !== undefined && { error_subcode: subcode }),
      },
    },
    { status: httpStatus },
  );
const tokenInvalid = () => graphError(400, 190);
const notFound = () => graphError(400, 100, 33);

/** Threads writes offsets as `+0000`. */
const threadsTime = (d: Date) => d.toISOString().replace('Z', '+0000');

export class FakeThreads {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly now: () => Date;
  private nextId = FIRST_ID;
  private nextToken = 1;
  private nextCode = 1;
  private readonly users = new Map<string, User>();
  private readonly media = new Map<string, Media>();
  private readonly tokens = new Map<string, Token>();
  private readonly authCodes = new Map<string, string>();
  private readonly containers = new Map<
    string,
    { userId: string; text: string; replyToId: string | null; mediaType: string }
  >();
  private readonly failures = new Map<ThreadsEndpoint, Failure[]>();
  private readonly log: FakeThreadsCall[] = [];

  constructor(o: { appId: string; appSecret: string; now?: () => Date }) {
    this.appId = o.appId;
    this.appSecret = o.appSecret;
    this.now = o.now ?? (() => new Date());
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = new URL(req?.url ?? String(input));
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? req?.headers);
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const form = Object.fromEntries(new URLSearchParams(rawBody));
    const query = Object.fromEntries(url.searchParams);
    const route = this.route(url.pathname, method);
    if (!route) return graphError(404);
    this.log.push({
      endpoint: route.endpoint,
      ...(route.id !== undefined && { id: route.id }),
      query,
      form,
    });

    const queue = this.failures.get(route.endpoint);
    const failure = queue?.[0];
    if (queue && failure) {
      if (--failure.times <= 0) queue.shift();
      return graphError(failure.httpStatus ?? 400, failure.code, failure.subcode);
    }
    const bearer = headers.get('authorization')?.replace(/^Bearer /i, '');
    return this.handle(route.endpoint, route.id, { query, form, bearer });
  };

  addUser(o: { username?: string; scopes?: string[] } = {}): { userId: string; authCode: string } {
    const id = this.id();
    this.users.set(id, {
      id,
      username: o.username ?? `user${this.users.size + 1}`,
      scopes: o.scopes ?? [...ALL_SCOPES],
      quotaUsed: 0,
    });
    const authCode = `code${this.nextCode++}`;
    this.authCodes.set(authCode, id);
    return { userId: id, authCode };
  }

  addPost(userId: string, o: { at?: Date } = {}): { postId: string } {
    const user = this.user(userId);
    const id = this.id();
    this.media.set(id, {
      id,
      parentId: null,
      rootId: id,
      authorId: userId,
      username: user.username,
      text: `post ${id}`,
      mediaType: 'TEXT_POST',
      at: o.at ?? this.now(),
      hide: 'NOT_HUSHED',
      deleted: false,
    });
    return { postId: id };
  }

  addReply(
    parentId: string,
    o: {
      text?: string;
      at: Date;
      byUserId?: string;
      username?: string | null;
      mediaType?: string;
    },
  ): { replyId: string } {
    const parent = this.media.get(parentId);
    if (!parent) throw new Error(`unknown parent ${parentId}`);
    const author = o.byUserId === undefined ? undefined : this.user(o.byUserId);
    const id = this.id();
    this.media.set(id, {
      id,
      parentId,
      rootId: parent.rootId,
      authorId: author?.id ?? null,
      username:
        o.username !== undefined ? o.username : (author?.username ?? `stranger${id.slice(-4)}`),
      text: o.text ?? 'reply',
      mediaType: o.mediaType ?? 'TEXT_POST',
      at: o.at,
      hide: 'NOT_HUSHED',
      deleted: false,
    });
    return { replyId: id };
  }

  deleteReply(id: string): void {
    const m = this.media.get(id);
    if (m) m.deleted = true;
  }

  hideStatus(id: string): string | undefined {
    return this.media.get(id)?.hide;
  }

  repliesBy(userId: string): { id: string; text: string; replyToId: string }[] {
    return [...this.media.values()]
      .filter((m) => m.parentId !== null && m.authorId === userId && !m.deleted)
      .map((m) => ({ id: m.id, text: m.text, replyToId: m.parentId! }));
  }

  setReplyQuotaUsage(userId: string, used: number): void {
    this.user(userId).quotaUsed = used;
  }

  revokeToken(token: string): void {
    const t = this.tokens.get(token);
    if (t) t.revoked = true;
  }

  expireAt(token: string, at: Date): void {
    const t = this.tokens.get(token);
    if (t) t.expiresAt = at;
  }

  failNext(
    endpoint: ThreadsEndpoint,
    o: { code?: number; subcode?: number; httpStatus?: number; times?: number },
  ): void {
    const q = this.failures.get(endpoint) ?? [];
    q.push({
      ...(o.code !== undefined && { code: o.code }),
      ...(o.subcode !== undefined && { subcode: o.subcode }),
      ...(o.httpStatus !== undefined && { httpStatus: o.httpStatus }),
      times: o.times ?? 1,
    });
    this.failures.set(endpoint, q);
  }

  signedDelivery(o: { replyId: string; ownerId?: string; rootPostId?: string; appId?: string }): {
    headers: Record<string, string>;
    rawBody: Buffer;
  } {
    const reply = this.media.get(o.replyId);
    if (!reply) throw new Error(`unknown reply ${o.replyId}`);
    const root = this.media.get(reply.rootId);
    const rootPostId = o.rootPostId ?? reply.rootId;
    const ownerId = o.ownerId ?? root?.authorId ?? '';
    const body = {
      object: 'threads',
      entry: [
        {
          id: ownerId,
          app_id: o.appId ?? this.appId,
          time: Math.floor(this.now().getTime() / 1000),
          changes: [
            {
              field: 'replies',
              value: {
                id: reply.id,
                ...(reply.username !== null && { username: reply.username }),
                text: reply.text,
                media_type: reply.mediaType,
                timestamp: threadsTime(reply.at),
                replied_to: { id: reply.parentId },
                root_post: { id: rootPostId, owner_id: ownerId },
              },
            },
          ],
        },
      ],
    };
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const sig = createHmac('sha256', this.appSecret).update(rawBody).digest('hex');
    return {
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${sig}` },
      rawBody,
    };
  }

  calls(endpoint?: ThreadsEndpoint): FakeThreadsCall[] {
    return this.log.filter((c) => endpoint === undefined || c.endpoint === endpoint);
  }

  // ---- internals ----

  private id(): string {
    return String(this.nextId++);
  }

  private user(id: string): User {
    const u = this.users.get(id);
    if (!u) throw new Error(`unknown user ${id}`);
    return u;
  }

  private route(path: string, method: string): { endpoint: ThreadsEndpoint; id?: string } | null {
    const get = method === 'GET';
    const post = method === 'POST';
    if (path === '/oauth/access_token' && post) return { endpoint: 'oauthToken' };
    if (path === '/access_token' && get) return { endpoint: 'longLived' };
    if (path === '/refresh_access_token' && get) return { endpoint: 'refresh' };
    if (path === '/v1.0/debug_token' && get) return { endpoint: 'debugToken' };
    if (path === '/v1.0/me' && get) return { endpoint: 'me' };
    if (path === '/v1.0/me/threads') {
      if (get) return { endpoint: 'meThreads' };
      if (post) return { endpoint: 'createContainer' };
    }
    const m = /^\/v1\.0\/(\d+)(?:\/(\w+))?$/.exec(path);
    if (!m) return null;
    const id = m[1]!;
    switch (m[2]) {
      case undefined:
        return get ? { endpoint: 'media', id } : null;
      case 'conversation':
        return get ? { endpoint: 'conversation', id } : null;
      case 'replies':
        return get ? { endpoint: 'replies', id } : null;
      case 'manage_reply':
        return post ? { endpoint: 'manageReply', id } : null;
      case 'threads_publish':
        return post ? { endpoint: 'publish', id } : null;
      case 'threads_publishing_limit':
        return get ? { endpoint: 'publishingLimit', id } : null;
      default:
        return null;
    }
  }

  /** The user behind a valid token, or null (answer 190). */
  private authenticate(token: string | undefined): User | null {
    if (token === undefined) return null;
    const t = this.tokens.get(token);
    if (!t || t.revoked || this.now().getTime() >= t.expiresAt.getTime()) return null;
    return this.users.get(t.userId) ?? null;
  }

  private issue(userId: string, ttlSec: number): string {
    const token = `tok${this.nextToken++}`;
    this.tokens.set(token, {
      userId,
      expiresAt: new Date(this.now().getTime() + ttlSec * 1000),
      revoked: false,
    });
    return token;
  }

  private handle(
    endpoint: ThreadsEndpoint,
    id: string | undefined,
    r: { query: Record<string, string>; form: Record<string, string>; bearer: string | undefined },
  ): Response {
    switch (endpoint) {
      case 'oauthToken':
        return this.oauthToken(r.form);
      case 'longLived':
      case 'refresh':
        return this.exchange(endpoint, r.query);
      default:
        break;
    }
    const me = this.authenticate(r.bearer ?? r.query.access_token);
    if (!me) return tokenInvalid();

    switch (endpoint) {
      case 'debugToken': {
        const input = r.query.input_token ?? '';
        const t = this.tokens.get(input);
        const u = this.authenticate(input);
        return Response.json({
          data: {
            app_id: this.appId,
            type: 'USER',
            is_valid: u !== null,
            ...(u &&
              t && {
                user_id: u.id,
                scopes: u.scopes,
                expires_at: Math.floor(t.expiresAt.getTime() / 1000),
              }),
          },
        });
      }
      case 'me':
        return Response.json(this.pick({ id: me.id, username: me.username }, r.query.fields));
      case 'meThreads': {
        const posts = [...this.media.values()]
          .filter((m) => m.parentId === null && m.authorId === me.id && !m.deleted)
          .sort(newestFirst);
        return this.page(posts, r.query, (m) => this.render(m, me));
      }
      case 'media': {
        const m = this.live(id!);
        return m ? Response.json(this.pick(this.render(m, me), r.query.fields)) : notFound();
      }
      case 'conversation': {
        const root = this.live(id!);
        if (!root) return notFound();
        if (root.parentId !== null) return graphError(400, 100);
        const replies = [...this.media.values()]
          .filter((m) => m.rootId === root.id && m.parentId !== null && !m.deleted)
          .sort(newestFirst);
        if (r.query.reverse === 'true') replies.reverse();
        return this.page(replies, r.query, (m) => this.render(m, me));
      }
      case 'replies': {
        const parent = this.live(id!);
        if (!parent) return notFound();
        const replies = [...this.media.values()]
          .filter((m) => m.parentId === parent.id && !m.deleted)
          .sort(newestFirst);
        return this.page(replies, r.query, (m) => this.render(m, me));
      }
      case 'manageReply': {
        if (!me.scopes.includes('threads_manage_replies')) return graphError(403, 10);
        const m = this.live(id!);
        if (!m) return notFound();
        if (m.parentId === null || m.parentId !== m.rootId) {
          return graphError(400, 100, NESTED_MANAGE_SUBCODE);
        }
        if (this.media.get(m.rootId)?.authorId !== me.id) return graphError(403, 10);
        const hide = r.form.hide === 'true';
        for (const d of [m, ...this.descendants(m.id)]) d.hide = hide ? 'HIDDEN' : 'UNHUSHED';
        return Response.json({ success: true });
      }
      case 'createContainer': {
        if (!me.scopes.includes('threads_content_publish')) return graphError(403, 10);
        const cid = this.id();
        this.containers.set(cid, {
          userId: me.id,
          text: r.form.text ?? '',
          replyToId: r.form.reply_to_id ?? null,
          mediaType: r.form.media_type ?? 'TEXT',
        });
        return Response.json({ id: cid });
      }
      case 'publish': {
        const c = this.containers.get(r.form.creation_id ?? '');
        if (!c || c.userId !== me.id || id !== me.id) return notFound();
        if (c.replyToId !== null) {
          if (me.quotaUsed >= REPLY_QUOTA_TOTAL) return graphError(400, 4, QUOTA_SUBCODE);
          const parent = this.live(c.replyToId);
          if (!parent) return notFound();
          this.containers.delete(r.form.creation_id!);
          me.quotaUsed++;
          const { replyId } = this.addReply(parent.id, {
            text: c.text,
            at: this.now(),
            byUserId: me.id,
          });
          return Response.json({ id: replyId });
        }
        this.containers.delete(r.form.creation_id!);
        const { postId } = this.addPost(me.id);
        const post = this.media.get(postId)!;
        post.text = c.text;
        return Response.json({ id: postId });
      }
      case 'publishingLimit': {
        if (id !== me.id) return notFound();
        return Response.json({
          data: [
            {
              reply_quota_usage: me.quotaUsed,
              reply_config: { quota_total: REPLY_QUOTA_TOTAL, quota_duration: 86_400 },
            },
          ],
        });
      }
      default:
        return graphError(404);
    }
  }

  private oauthToken(form: Record<string, string>): Response {
    if (form.client_id !== this.appId || form.client_secret !== this.appSecret) {
      return graphError(400, 101);
    }
    const userId = this.authCodes.get(form.code ?? '');
    if (userId === undefined) return graphError(400, 100);
    this.authCodes.delete(form.code!);
    return Response.json({
      access_token: this.issue(userId, SHORT_LIVED_TTL_SEC),
      user_id: userId,
    });
  }

  private exchange(endpoint: 'longLived' | 'refresh', q: Record<string, string>): Response {
    const expected = endpoint === 'longLived' ? 'th_exchange_token' : 'th_refresh_token';
    if (q.grant_type !== expected) return graphError(400, 100);
    if (endpoint === 'longLived' && q.client_secret !== this.appSecret) return graphError(400, 101);
    const u = this.authenticate(q.access_token);
    if (!u) return tokenInvalid();
    return Response.json({
      access_token: this.issue(u.id, LONG_LIVED_TTL_SEC),
      token_type: 'bearer',
      expires_in: LONG_LIVED_TTL_SEC,
    });
  }

  private live(id: string): Media | undefined {
    const m = this.media.get(id);
    return m && !m.deleted ? m : undefined;
  }

  private descendants(id: string): Media[] {
    const out: Media[] = [];
    const walk = (pid: string) => {
      for (const m of this.media.values()) {
        if (m.parentId === pid) {
          out.push(m);
          walk(m.id);
        }
      }
    };
    walk(id);
    return out;
  }

  private render(m: Media, me: User): Obj {
    return {
      id: m.id,
      text: m.text,
      ...(m.username !== null && { username: m.username }),
      timestamp: threadsTime(m.at),
      media_type: m.mediaType,
      permalink: `https://www.threads.com/@${m.username ?? 'unknown'}/post/${m.id}`,
      hide_status: m.hide,
      is_reply: m.parentId !== null,
      is_reply_owned_by_me: m.authorId === me.id,
      root_post: { id: m.rootId },
      ...(m.parentId !== null && { replied_to: { id: m.parentId } }),
    };
  }

  private pick(o: Obj, fields: string | undefined): Obj {
    if (!fields) return o;
    const want = new Set(['id', ...fields.split(',')]);
    return Object.fromEntries(Object.entries(o).filter(([k]) => want.has(k)));
  }

  private page(items: Media[], q: Record<string, string>, render: (m: Media) => Obj): Response {
    const limit = Math.min(Math.max(Number(q.limit ?? PAGE_SIZE) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const cursor = q.after ? /^o(\d+)$/.exec(q.after) : null;
    if (q.after && !cursor) return graphError(400, 100);
    const offset = cursor ? Number(cursor[1]) : 0;
    const slice = items.slice(offset, offset + limit);
    const more = offset + limit < items.length;
    return Response.json({
      data: slice.map((m) => this.pick(render(m), q.fields)),
      paging: {
        cursors: {
          before: `o${offset}`,
          ...(more && { after: `o${offset + limit}` }),
        },
      },
    });
  }
}

const newestFirst = (a: Media, b: Media) =>
  b.at.getTime() - a.at.getTime() || Number(BigInt(b.id) - BigInt(a.id));
