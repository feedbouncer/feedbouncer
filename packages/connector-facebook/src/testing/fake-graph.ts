// A fetch-compatible in-memory Graph API double: users, Pages, comments, the
// OAuth code/token exchange, Bearer + appsecret_proof checks, token-to-Page
// binding, error injection and a call log that never holds a token.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { PRIVATE_REPLY_WINDOW_MS } from '@feedbouncer/connectors';
import {
  addAd,
  deleteAd,
  addAdAccount,
  createAdsState,
  routeAds,
  setAdCreative,
  setAdStatus,
  type AddAdOptions,
  type AdsHost,
} from './fake-ads.js';
import {
  FAKE_IG_SCOPES,
  addIgComment,
  addIgMedia,
  addInstagramAccount,
  createIgState,
  igPrivateReplies,
  igReplies,
  igState,
  instagramDeliveryBody,
  linkedAccount,
  ownerDeletes,
  ownerHides,
  routeInstagram,
  type AddIgCommentOptions,
  type IgDeliveryComment,
  type IgHost,
} from './fake-instagram.js';

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
  /** Calls to let through before this failure fires. */
  after?: number;
  /** Fires only on a request whose path ends with this. */
  path?: string;
}
interface PostMeta {
  createdAtMs: number;
  pinned: boolean;
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
  private readonly postMeta = new Map<string, PostMeta>();
  private readonly feedExtras = new Map<string, Record<string, unknown>[]>();
  private readonly tokens = new Map<string, TokenInfo>();
  private readonly shortTokens = new Map<string, string>(); // short token -> user id
  private readonly codes = new Map<string, Consent>();
  private readonly issued: string[] = [];
  private readonly log: { method: string; path: string }[] = [];
  private readonly injected: Injected[] = [];
  private readonly ig = createIgState();
  private readonly igHost: IgHost;
  private readonly ads = createAdsState();
  private readonly adsHost: AdsHost;

  constructor(opts: FakeGraphOptions) {
    this.appSecret = opts.appSecret;
    this.appId = opts.appId;
    this.version = opts.version ?? 'v26.0';
    this.clock = opts.clock ?? Date.now;
    this.fetch = (input, init) => this.handle(input, init);
    this.adsHost = {
      graphTime,
      reply: (status, body, headers) => this.reply(status, body, headers),
      error: (code, subcode) => this.error(code, subcode),
    };
    this.igHost = {
      clock: () => this.clock(),
      graphTime,
      reply: (status, body) => this.reply(status, body),
      error: (code, subcode) => this.error(code, subcode),
      pageOwner: (pageId) => this.pages.get(pageId)?.userId,
      permissionGranted: (userId, permission) => {
        const explicit = this.ig.granted.get(userId);
        if (explicit) return explicit.includes(permission);
        return !this.grantedScopes.get(userId)?.declined.includes(permission);
      },
    };
  }

  // instagram controls and observation (implemented in fake-instagram.ts)

  addInstagramAccount(pageId: string, o: { username?: string } = {}): { igUserId: string } {
    if (!this.pages.has(pageId)) throw new Error('unknown page');
    return addInstagramAccount(this.ig, pageId, o);
  }

  addIgComment(
    igUserId: string,
    o: AddIgCommentOptions = {},
  ): { mediaId: string; commentId: string } {
    return addIgComment(this.ig, this.clock(), igUserId, o);
  }

  igState(commentId: string): 'visible' | 'hidden' | 'deleted' {
    return igState(this.ig, commentId);
  }

  igReplies(commentId: string): readonly { id: string; text: string; fromId: string }[] {
    return igReplies(this.ig, commentId);
  }

  igPrivateReplies(commentId: string): readonly string[] {
    return igPrivateReplies(this.ig, commentId);
  }

  /** The owner acted in the Instagram app: no webhook is produced. */
  ownerHides(commentId: string): void {
    ownerHides(this.ig, commentId);
  }

  ownerDeletes(commentId: string): void {
    ownerDeletes(this.ig, commentId);
  }

  /** Drives GET me/permissions and the private-reply permission error. */
  setGrantedPermissions(userId: string, perms: readonly string[]): void {
    if (!this.users.has(userId)) throw new Error('unknown user');
    this.ig.granted.set(userId, [...perms]);
  }

  signedInstagramDelivery(
    igUserId: string,
    comments: readonly IgDeliveryComment[],
    o: { timeUnit?: 's' | 'ms' } = {},
  ): { headers: Record<string, string>; rawBody: Buffer } {
    return this.sign(
      instagramDeliveryBody(this.ig, this.clock(), igUserId, comments, o.timeUnit ?? 's'),
    );
  }

  // ads controls (implemented in fake-ads.ts)

  addAdAccount(
    userId: string,
    o: { name?: string; accountStatus?: number } = {},
  ): { adAccountId: string } {
    if (!this.users.has(userId)) throw new Error('unknown user');
    return addAdAccount(this.ads, this.nextId(5_000_000_000), userId, o);
  }

  addAd(adAccountId: string, o: AddAdOptions = {}): { adId: string; creativeId: string } {
    const ids = { adId: this.nextId(6_000_000_000), creativeId: this.nextId(7_000_000_000) };
    return addAd(this.ads, this.clock(), ids, adAccountId, o);
  }

  removeAds(adAccountId: string): void {
    for (const [id, ad] of this.ads.ads) if (ad.accountId === adAccountId) this.ads.ads.delete(id);
  }

  deleteAd(adId: string, mode: 'status' | 'gone'): void {
    deleteAd(this.ads, this.clock(), adId, mode);
  }

  setAdStatus(adId: string, status: string): void {
    setAdStatus(this.ads, this.clock(), adId, status);
  }

  setAdCreative(
    adId: string,
    patch: { storyId?: string | null; igMediaId?: string | null; igUserId?: string | null },
  ): void {
    setAdCreative(this.ads, this.clock(), adId, patch);
  }

  /** Ad listings for this user/account answer Graph error `code` from now on. */
  revokeAdAccountAccess(userId: string, adAccountId: string, code = 200): void {
    this.ads.revoked.set(`${userId}:${adAccountId}`, code);
  }

  /** A Page post that never appears in the Page feed (an ad "dark post"). */
  addDarkPost(pageId: string): { postId: string } {
    if (!this.pages.has(pageId)) throw new Error('unknown page');
    const postId = `${pageId}_${++this.seq}`;
    this.posts.set(postId, pageId);
    this.noteCreated(postId);
    this.ads.dark.add(postId);
    return { postId };
  }

  addPost(pageId: string, o: { createdAtMs?: number; pinned?: boolean } = {}): { postId: string } {
    if (!this.pages.has(pageId)) throw new Error('unknown page');
    const postId = `${pageId}_${++this.seq}`;
    this.posts.set(postId, pageId);
    this.noteCreated(postId, o);
    return { postId };
  }

  /** The Page owner hid the comment; no webhook is produced. */
  hideComment(commentId: string): void {
    this.comment(commentId).hidden = true;
  }

  addIgMedia(igUserId: string, o: { createdAtMs?: number } = {}): { mediaId: string } {
    return addIgMedia(this.ig, this.clock(), igUserId, o);
  }

  /** A raw item appended to the first page of that Page's /feed. */
  injectFeedItem(pageId: string, raw: Record<string, unknown>): void {
    const items = this.feedExtras.get(pageId) ?? [];
    items.push(raw);
    this.feedExtras.set(pageId, items);
  }

  /** GET <post>/comments answers 100/33 afterwards. */
  removePost(postId: string): void {
    this.posts.delete(postId);
    this.ads.dark.delete(postId);
  }

  /** Emitted as X-Ad-Account-Usage on that account's ad listings. */
  setAdAccountUsage(adAccountId: string, utilPct: number, resetSec: number): void {
    const account = this.ads.accounts.get(adAccountId);
    if (!account) throw new Error('unknown ad account');
    account.usage = { utilPct, resetSec };
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
    this.noteCreated(postId);
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

  /** Throttles the next call, or the one after `afterCalls` more calls. */
  throttleNext(code = 80001, minutes = 1, o: { afterCalls?: number } = {}): void {
    const after = o.afterCalls ?? 0;
    this.injected.push({ code, minutes, ...(after > 0 ? { after } : {}) });
  }

  /** Fails the next call, or the one after `afterCalls` more calls. */
  failNext(code: number, subcode?: number, afterCalls = 0): void {
    this.injected.push({
      code,
      ...(subcode !== undefined ? { subcode } : {}),
      ...(afterCalls > 0 ? { after: afterCalls } : {}),
    });
  }

  /** Fails the next call whose path ends with `pathSuffix`. */
  failNextFor(pathSuffix: string, code: number, subcode?: number): void {
    this.injected.push({
      code,
      path: pathSuffix,
      ...(subcode !== undefined ? { subcode } : {}),
    });
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
    return this.sign(body);
  }

  private sign(body: unknown): { headers: Record<string, string>; rawBody: Buffer } {
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

  private noteCreated(postId: string, o: { createdAtMs?: number; pinned?: boolean } = {}): void {
    if (this.postMeta.has(postId)) return;
    this.postMeta.set(postId, {
      createdAtMs: o.createdAtMs ?? this.clock(),
      pinned: o.pinned ?? false,
    });
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

    const suffix = `/${path.join('/')}`;
    const applies = (i: Injected) => i.path === undefined || suffix.endsWith(i.path);
    const due = this.injected.findIndex((i) => applies(i) && (i.after ?? 0) === 0);
    const inj = due >= 0 ? this.injected.splice(due, 1)[0] : undefined;
    for (const i of this.injected) if (i.after && applies(i)) i.after -= 1;
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
      const explicit = this.ig.granted.get(who.id);
      if (explicit || !c) {
        const list = explicit ?? FAKE_IG_SCOPES;
        return this.reply(200, {
          data: list.map((permission) => ({ permission, status: 'granted' })),
        });
      }
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
        .map((p) => {
          const ig = linkedAccount(this.ig, p.id);
          return {
            id: p.id,
            name: p.name,
            tasks: p.tasks,
            access_token: p.token,
            ...(ig ? { instagram_business_account: ig } : {}),
          };
        });
      return this.reply(200, { data });
    }
    const adsResponse = routeAds(this.ads, this.adsHost, method, path, query, who);
    if (adsResponse) return adsResponse;
    if (first === 'me' || !first || path.length > 2) return missing();

    const igResponse = routeInstagram(this.ig, this.igHost, method, path, query, form, json, who);
    if (igResponse) return igResponse;

    // Everything else addresses a Page-owned object: the first id segment is the Page.
    const owner = first.split('_')[0]!;
    const page = this.pages.get(owner);
    if (!page) return missing();
    if (who.kind !== 'page' || who.id !== owner) return denied();

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
      case 'feed': {
        if (method !== 'GET') return this.error(100);
        const sinceSec = query.get('since');
        const sinceMs =
          sinceSec !== null && /^\d{1,12}$/.test(sinceSec) ? Number(sinceSec) * 1000 : null;
        const posts = [...this.posts]
          .filter(([id, pageId]) => pageId === owner && !this.ads.dark.has(id))
          .map(([id]) => ({ id, ...(this.postMeta.get(id) ?? { createdAtMs: 0, pinned: false }) }))
          .filter((p) => sinceMs === null || p.createdAtMs >= sinceMs);
        posts.sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            b.createdAtMs - a.createdAtMs ||
            b.id.localeCompare(a.id),
        );
        const items: Record<string, unknown>[] = posts.map((p) => ({
          id: p.id,
          created_time: graphTime(p.createdAtMs),
          permalink_url: `https://www.facebook.com/${p.id}`,
        }));
        const limit = Number(query.get('limit') ?? '25');
        const size = Number.isInteger(limit) && limit > 0 ? limit : 25;
        const after = query.get('after') ?? '';
        const start = /^[A-Za-z0-9_-]{1,12}$/.test(after)
          ? Number(Buffer.from(after, 'base64url').toString('utf8')) || 0
          : 0;
        const end = start + size;
        const data = items.slice(start, end);
        if (start === 0) data.push(...(this.feedExtras.get(owner) ?? []));
        const cursor = Buffer.from(String(end), 'utf8').toString('base64url');
        return this.reply(200, {
          data,
          paging: {
            cursors: { after: cursor },
            ...(end < items.length
              ? { next: `https://graph.facebook.com/${first}/feed?after=${cursor}` }
              : {}),
          },
        });
      }
      case 'comments': {
        if (method === 'GET') {
          const isPost = this.posts.get(first) === owner;
          const parent = this.comments.get(first);
          if (!isPost && (!parent || parent.deleted)) return missing();
          const paged = query.has('limit') || query.has('after');
          const topOnly = paged && isPost && query.get('filter') !== 'stream';
          const matching = [...this.comments.values()]
            .filter((c) => !c.deleted && (isPost ? c.postId === first : c.parentId === first))
            .filter((c) => !topOnly || c.parentId === null);
          if (paged) {
            matching.sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id));
          }
          const data = matching.map((c) => ({
            id: c.id,
            message: c.message,
            created_time: graphTime(c.createdAtMs),
            from: { id: c.authorId },
            ...(c.parentId ? { parent: { id: c.parentId } } : {}),
            is_hidden: c.hidden,
          }));
          const limit = Number(query.get('limit') ?? '25');
          if (!paged) {
            return this.reply(200, { data: data.slice(0, Number.isFinite(limit) ? limit : 25) });
          }
          const size = Number.isInteger(limit) && limit > 0 ? limit : 25;
          const after = query.get('after') ?? '';
          const start = /^p\d{1,9}$/.test(after) ? Number(after.slice(1)) : 0;
          const end = start + size;
          return this.reply(200, {
            data: data.slice(start, end),
            paging: {
              cursors: { after: `p${end}` },
              ...(end < data.length
                ? { next: `https://graph.facebook.com/${first}/comments?after=p${end}` }
                : {}),
            },
          });
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
