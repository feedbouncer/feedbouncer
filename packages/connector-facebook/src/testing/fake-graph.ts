// A fetch-compatible in-memory Graph API double: users, Pages, comments, the
// OAuth code/token exchange, Bearer + appsecret_proof checks, token-to-Page
// binding, error injection and a call log that never holds a token.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { PRIVATE_REPLY_WINDOW_MS } from '@feedbouncer/connectors';

const HOST = 'graph.facebook.com';

interface User {
  id: string;
  name: string;
}
interface Page {
  id: string;
  name: string;
  userId: string;
  tasks: string[];
  token: string;
  subscriptions: Map<string, string[]>; // app id -> subscribed fields
  blocked: Set<string>;
}
interface Comment {
  id: string;
  pageId: string;
  postId: string;
  parentId: string | null;
  authorId: string;
  message: string;
  createdAtMs: number;
  hidden: boolean;
  deleted: boolean;
  privateReplies: string[];
}
interface TokenInfo {
  kind: 'user' | 'page';
  id: string;
  revoked?: number;
}
interface Consent {
  userId: string;
  challenge: string;
  redirectUri: string;
  scopes: string[];
  declined: string[];
}
interface Injected {
  code: number;
  subcode?: number;
  minutes?: number;
}

export interface FakeGraphOptions {
  appSecret: string;
  appId: string;
  version?: string;
  clock?: () => number;
}

const sha256b64url = (s: string) => createHash('sha256').update(s).digest('base64url');
const hex = (bytes = 24) => randomBytes(bytes).toString('hex');
const graphTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');

export class FakeGraph {
  readonly fetch: typeof globalThis.fetch;
  private readonly appSecret: string;
  private readonly appId: string;
  private readonly version: string;
  private readonly clock: () => number;
  private seq = 0;
  private readonly users = new Map<string, User>();
  private readonly pages = new Map<string, Page>();
  private readonly comments = new Map<string, Comment>();
  private readonly posts = new Map<string, string>(); // post id -> page id
  private readonly tokens = new Map<string, TokenInfo>();
  private readonly shortTokens = new Map<string, string>(); // short token -> user id
  private readonly codes = new Map<string, Consent>();
  private readonly issued: string[] = [];
  private readonly log: { method: string; path: string }[] = [];
  private readonly injected: Injected[] = [];

  constructor(opts: FakeGraphOptions) {
    this.appSecret = opts.appSecret;
    this.appId = opts.appId;
    this.version = opts.version ?? 'v26.0';
    this.clock = opts.clock ?? Date.now;
    this.fetch = (input, init) => this.handle(input, init);
  }

  // controls

  addUser(name = 'User'): { userId: string } {
    const id = this.nextId(2_000_000_000);
    this.users.set(id, { id, name });
    return { userId: id };
  }

  addPage(
    userId: string,
    opts: { tasks?: string[]; name?: string } = {},
  ): { pageId: string; pageToken: string } {
    if (!this.users.has(userId)) throw new Error('unknown user');
    const id = this.nextId(1_000_000_000);
    const token = this.issue(`page-token-${hex()}`, { kind: 'page', id });
    this.pages.set(id, {
      id,
      name: opts.name ?? `Page ${id}`,
      userId,
      tasks: opts.tasks ?? ['MODERATE', 'MESSAGING'],
      token,
      subscriptions: new Map(),
      blocked: new Set(),
    });
    return { pageId: id, pageToken: token };
  }

  consent(
    authorizationUrl: URL,
    userId: string,
    opts: { decline?: string[] } = {},
  ): { code: string; state: string } {
    const p = authorizationUrl.searchParams;
    const state = p.get('state');
    const challenge = p.get('code_challenge');
    if (!state || !challenge || !this.users.has(userId)) throw new Error('bad consent request');
    const scopes = (p.get('scope') ?? '').split(',').filter(Boolean);
    const declined = opts.decline ?? [];
    const code = this.issue(`code-${hex()}`);
    this.codes.set(code, {
      userId,
      challenge,
      redirectUri: p.get('redirect_uri') ?? '',
      scopes: scopes.filter((s) => !declined.includes(s)),
      declined: scopes.filter((s) => declined.includes(s)),
    });
    return { code, state };
  }

  addComment(
    pageId: string,
    opts: {
      postId?: string;
      authorId?: string;
      parentId?: string;
      message?: string;
      createdAtMs?: number;
    } = {},
  ): { postId: string; commentId: string } {
    if (!this.pages.has(pageId)) throw new Error('unknown page');
    const postId = opts.postId ?? `${pageId}_${++this.seq}`;
    this.posts.set(postId, pageId);
    const id = `${postId}_${++this.seq}`;
    this.comments.set(id, {
      id,
      pageId,
      postId,
      parentId: opts.parentId ?? null,
      authorId: opts.authorId ?? this.nextId(3_000_000_000),
      message: opts.message ?? 'hello',
      createdAtMs: opts.createdAtMs ?? this.clock(),
      hidden: false,
      deleted: false,
      privateReplies: [],
    });
    return { postId, commentId: id };
  }

  editComment(commentId: string, message: string): void {
    this.comment(commentId).message = message;
  }

  removeComment(commentId: string): void {
    this.comment(commentId).deleted = true;
  }

  /** The Page's token answers 190/<subcode> from now on. */
  revokePageToken(pageId: string, subcode = 463): void {
    const page = this.pages.get(pageId);
    const info = page && this.tokens.get(page.token);
    if (!info) throw new Error('unknown page');
    info.revoked = subcode;
  }

  throttleNext(code = 80001, minutes = 1): void {
    this.injected.push({ code, minutes });
  }

  failNext(code: number, subcode?: number): void {
    this.injected.push({ code, ...(subcode !== undefined ? { subcode } : {}) });
  }

  // observation

  state(commentId: string): 'visible' | 'hidden' | 'deleted' {
    const c = this.comment(commentId);
    return c.deleted ? 'deleted' : c.hidden ? 'hidden' : 'visible';
  }

  replies(commentId: string): { id: string; fromId: string; message: string }[] {
    return [...this.comments.values()]
      .filter((c) => c.parentId === commentId && !c.deleted)
      .map((c) => ({ id: c.id, fromId: c.authorId, message: c.message }));
  }

  privateReplies(commentId: string): string[] {
    return [...this.comment(commentId).privateReplies];
  }

  blocked(pageId: string): string[] {
    return [...(this.pages.get(pageId)?.blocked ?? [])];
  }

  subscribed(pageId: string): boolean {
    return this.subscribedFields(pageId).length > 0;
  }

  /** Fields this app is subscribed to on the Page; [] when not subscribed. */
  subscribedFields(pageId: string): readonly string[] {
    return [...(this.pages.get(pageId)?.subscriptions.get(this.appId) ?? [])];
  }

  setSubscription(pageId: string, appId: string, fields: readonly string[]): void {
    const page = this.pages.get(pageId);
    if (!page) throw new Error('unknown page');
    page.subscriptions.set(appId, [...fields]);
  }

  /** Same as setSubscription; named for tests about subscriptions owned by another app. */
  setOtherAppSubscription(pageId: string, appId: string, fields: readonly string[]): void {
    this.setSubscription(pageId, appId, fields);
  }

  /** The app secret, for building appsecret_proof in test call helpers. */
  appSecretValue(): string {
    return this.appSecret;
  }

  /** Every token and code ever issued, plus the app secret. */
  issuedSecrets(): string[] {
    return [...this.issued, this.appSecret];
  }

  calls(): { method: string; path: string }[] {
    return this.log.map((c) => ({ ...c }));
  }

  signedDelivery(
    pageId: string,
    changes: { verb: string; commentId: string; postId: string; parentId?: string }[],
  ): { headers: Record<string, string>; rawBody: Buffer } {
    const now = this.clock();
    const body = {
      object: 'page',
      entry: [
        {
          id: pageId,
          time: Math.floor(now / 1000),
          changes: changes.map((c) => ({
            field: 'feed',
            value: {
              item: 'comment',
              verb: c.verb,
              comment_id: c.commentId,
              post_id: c.postId,
              ...(c.parentId ? { parent_id: c.parentId } : {}),
              created_time: Math.floor(now / 1000),
            },
          })),
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

  // internals

  private nextId(base: number): string {
    return String(base + ++this.seq);
  }

  private issue(secret: string, info?: TokenInfo): string {
    this.issued.push(secret);
    if (info) this.tokens.set(secret, info);
    return secret;
  }

  private comment(id: string): Comment {
    const c = this.comments.get(id);
    if (!c) throw new Error('unknown comment');
    return c;
  }

  private reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  private error(code: number, subcode?: number, status = 400, headers = {}): Response {
    return this.reply(
      status,
      { error: { message: 'fake graph error', type: 'GraphError', code, error_subcode: subcode } },
      headers,
    );
  }

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.protocol !== 'https:' || url.hostname !== HOST) throw new Error('unreachable host');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== this.version) return this.error(2500, undefined, 400);
    const path = parts.slice(1);
    this.log.push({ method, path: path.join('/') });

    const headers = new Headers(init?.headers);
    const bearer = /^Bearer (\S+)$/.exec(headers.get('authorization') ?? '')?.[1] ?? null;
    const info = bearer ? this.tokens.get(bearer) : undefined;

    const inj = this.injected.shift();
    if (inj) {
      if (inj.minutes !== undefined) {
        const key = info?.id ?? 'app';
        const buc = {
          [key]: [
            {
              type: 'pages',
              call_count: 100,
              estimated_time_to_regain_access: inj.minutes,
            },
          ],
        };
        return this.error(inj.code, undefined, 400, {
          'x-business-use-case-usage': JSON.stringify(buc),
        });
      }
      return this.error(inj.code, inj.subcode);
    }

    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const form = new URLSearchParams();
    let json: unknown = null;
    if (rawBody) {
      if ((headers.get('content-type') ?? '').includes('json')) {
        try {
          json = JSON.parse(rawBody);
        } catch {
          return this.error(100);
        }
      } else {
        for (const [k, v] of new URLSearchParams(rawBody)) form.set(k, v);
      }
    }

    if (path.length === 2 && path[0] === 'oauth' && path[1] === 'access_token') {
      return method === 'POST' ? this.oauthToken(form) : this.error(100);
    }

    if (!bearer || !info) return this.error(190, undefined, 401);
    if (info.revoked !== undefined) return this.error(190, info.revoked, 401);
    const proof = createHmac('sha256', this.appSecret).update(bearer).digest('hex');
    if (url.searchParams.get('appsecret_proof') !== proof) return this.error(100);

    return this.route(method, path, url.searchParams, form, json, info);
  }

  private oauthToken(form: URLSearchParams): Response {
    if (form.get('client_id') !== this.appId || form.get('client_secret') !== this.appSecret) {
      return this.error(1, undefined, 400);
    }
    const grant = form.get('grant_type');
    if (grant === 'fb_exchange_token') {
      const userId = this.shortTokens.get(form.get('fb_exchange_token') ?? '');
      if (!userId) return this.error(190, 467, 400);
      const long = this.issue(`user-long-${hex()}`, { kind: 'user', id: userId });
      return this.reply(200, { access_token: long, token_type: 'bearer', expires_in: 5_184_000 });
    }
    if (grant !== null) return this.error(100);
    const code = form.get('code') ?? '';
    const consent = this.codes.get(code);
    this.codes.delete(code); // single use
    const verifier = form.get('code_verifier') ?? '';
    if (
      !consent ||
      consent.redirectUri !== form.get('redirect_uri') ||
      sha256b64url(verifier) !== consent.challenge
    ) {
      return this.error(100, 36009);
    }
    const short = this.issue(`user-short-${hex()}`);
    this.shortTokens.set(short, consent.userId);
    this.grantedScopes.set(consent.userId, consent);
    return this.reply(200, { access_token: short, token_type: 'bearer', expires_in: 3600 });
  }

  private readonly grantedScopes = new Map<string, Consent>();

  private route(
    method: string,
    path: string[],
    query: URLSearchParams,
    form: URLSearchParams,
    json: unknown,
    who: TokenInfo,
  ): Response {
    const missing = () => this.error(100, 33);
    const denied = () => this.error(200);
    // `me` with a Page token addresses that Page's subscriptions.
    if (path[0] === 'me' && path[1] === 'subscribed_apps' && who.kind === 'page') {
      path = [who.id, 'subscribed_apps'];
    }
    const [first, second] = path;

    if (first === 'me' && path.length === 1 && method === 'GET') {
      const name =
        who.kind === 'user' ? this.users.get(who.id)?.name : this.pages.get(who.id)?.name;
      return this.reply(200, { id: who.id, name });
    }
    if (first === 'me' && second === 'permissions' && path.length === 2 && method === 'GET') {
      if (who.kind !== 'user') return denied();
      const c = this.grantedScopes.get(who.id);
      return this.reply(200, {
        data: [
          ...(c?.scopes ?? []).map((permission) => ({ permission, status: 'granted' })),
          ...(c?.declined ?? []).map((permission) => ({ permission, status: 'declined' })),
        ],
      });
    }
    if (first === 'me' && second === 'accounts' && path.length === 2 && method === 'GET') {
      if (who.kind !== 'user') return denied();
      const data = [...this.pages.values()]
        .filter((p) => p.userId === who.id)
        .map((p) => ({ id: p.id, name: p.name, tasks: p.tasks, access_token: p.token }));
      return this.reply(200, { data });
    }
    if (first === 'me' || !first || path.length > 2) return missing();

    // Everything else addresses a Page-owned object: the first id segment is the Page.
    const owner = first.split('_')[0]!;
    if (who.kind !== 'page' || who.id !== owner) return denied();
    const page = this.pages.get(owner);
    if (!page) return missing();

    if (path.length === 1) {
      const c = this.comments.get(first);
      if (!c || c.deleted) return missing();
      if (method === 'GET') {
        return this.reply(200, {
          id: c.id,
          message: c.message,
          created_time: graphTime(c.createdAtMs),
          from: { id: c.authorId, name: `User ${c.authorId}` },
          ...(c.parentId ? { parent: { id: c.parentId } } : {}),
          is_hidden: c.hidden,
          permalink_url: `https://www.facebook.com/${c.id}`,
        });
      }
      if (method === 'POST') {
        const hidden = form.get('is_hidden');
        if (hidden !== 'true' && hidden !== 'false') return this.error(100);
        c.hidden = hidden === 'true';
        return this.reply(200, { success: true });
      }
      if (method === 'DELETE') {
        c.deleted = true;
        return this.reply(200, { success: true });
      }
      return this.error(100);
    }

    switch (second) {
      case 'comments': {
        if (method === 'GET') {
          const isPost = this.posts.get(first) === owner;
          const parent = this.comments.get(first);
          if (!isPost && (!parent || parent.deleted)) return missing();
          const data = [...this.comments.values()]
            .filter((c) => !c.deleted && (isPost ? c.postId === first : c.parentId === first))
            .map((c) => ({
              id: c.id,
              message: c.message,
              created_time: graphTime(c.createdAtMs),
              from: { id: c.authorId },
              ...(c.parentId ? { parent: { id: c.parentId } } : {}),
              is_hidden: c.hidden,
            }));
          const limit = Number(query.get('limit') ?? '25');
          return this.reply(200, { data: data.slice(0, Number.isFinite(limit) ? limit : 25) });
        }
        if (method === 'POST') {
          const parent = this.comments.get(first);
          if (!parent || parent.deleted) return missing();
          const message = form.get('message');
          if (!message) return this.error(100);
          const r = this.addComment(owner, {
            postId: parent.postId,
            parentId: parent.id,
            authorId: owner,
            message,
          });
          return this.reply(200, { id: r.commentId });
        }
        return this.error(100);
      }
      case 'blocked': {
        const user = (method === 'DELETE' ? query.get('user') : form.get('user')) ?? '';
        if (!/^\d{1,32}$/.test(user) || user === owner) return this.error(100);
        if (method === 'POST') {
          page.blocked.add(user);
          return this.reply(200, { [user]: true });
        }
        if (method === 'DELETE') {
          page.blocked.delete(user);
          return this.reply(200, { success: true });
        }
        return this.error(100);
      }
      case 'subscribed_apps': {
        if (method === 'GET') {
          const data = [...page.subscriptions].map(([id, subscribed_fields]) => ({
            id,
            name: 'x',
            subscribed_fields,
          }));
          return this.reply(200, { data });
        }
        if (method === 'POST') {
          // Graph replaces the calling app's field list; merging is the client's job.
          const fields = (form.get('subscribed_fields') ?? '').split(',').filter(Boolean);
          if (fields.length === 0) return this.error(100);
          page.subscriptions.set(this.appId, fields);
          return this.reply(200, { success: true });
        }
        if (method === 'DELETE') {
          page.subscriptions.delete(this.appId);
          return this.reply(200, { success: true });
        }
        return this.error(100);
      }
      case 'messages': {
        if (method !== 'POST') return this.error(100);
        const body = json as {
          recipient?: { comment_id?: unknown };
          message?: { text?: unknown };
        } | null;
        const commentId = body?.recipient?.comment_id;
        const text = body?.message?.text;
        if (typeof commentId !== 'string' || typeof text !== 'string') return this.error(100);
        const c = this.comments.get(commentId);
        if (!c || c.deleted) return missing();
        if (c.pageId !== owner) return denied();
        if (this.clock() - c.createdAtMs >= PRIVATE_REPLY_WINDOW_MS) return this.error(10, 2018278);
        if (c.privateReplies.length > 0) return this.error(10900);
        c.privateReplies.push(text);
        return this.reply(200, { recipient_id: c.authorId, message_id: `m_${hex(12)}` });
      }
      default:
        return missing();
    }
  }
}
