import { TIKTOK_ENDPOINTS, type TikTokEndpoint } from '../endpoints.js';

// Stateful fake of TikTok Accounts (organic) and the Marketing API, implementing
// the primary assumptions V2-V8 and V11-V14. Organic and ad comments live in
// separate maps; `deleteComment` / `commentState` look in both.

type Obj = Record<string, unknown>;
type State = 'PUBLIC' | 'HIDDEN' | 'DELETED';
type Product = 'accounts' | 'marketing';

interface Comment {
  id: string;
  itemId: string;
  text: string;
  createdAtSec: number;
  parentId?: string;
  userId: string;
  username: string;
  hidden: boolean;
  deleted: boolean;
  advertiserId?: string;
  adId?: string;
}
interface Token {
  kind: 'tt' | 'ad';
  ids: string[];
  expiresAtMs?: number;
  expired: boolean;
}

class Fail {
  constructor(
    readonly code: number,
    readonly status = 200,
  ) {}
}

const AD_ENDPOINTS = new Set<string>(
  Object.keys(TIKTOK_ENDPOINTS).filter((k) => k.startsWith('ad')),
);
const NO_TOKEN = new Set<TikTokEndpoint>([
  'ttToken',
  'ttRefresh',
  'adOauthToken',
  'adOauthRefresh',
]);
const productOf = (e: TikTokEndpoint): Product => (AD_ENDPOINTS.has(e) ? 'marketing' : 'accounts');
const newestFirst = (a: Comment, b: Comment) =>
  b.createdAtSec - a.createdAtSec || (BigInt(b.id) > BigInt(a.id) ? 1 : -1);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export class FakeTikTok {
  private nextId = 7300000000000000000n;
  private expiringAds = false;
  private beforeNextPage: (() => void) | undefined;
  private readonly accounts = new Map<string, { username: string; scopes: string[] }>();
  private readonly advertisers = new Map<string, string>();
  private readonly authCodes = new Map<string, { kind: 'tt' | 'ad'; id: string }>();
  private readonly videos = new Map<
    string,
    { businessId: string; createdAtSec: number; shareUrl: string }
  >();
  private readonly organic = new Map<string, Comment>();
  private readonly ads = new Map<string, Comment>();
  private readonly replyLog = new Map<string, { text: string }[]>();
  private readonly tokens = new Map<string, Token>();
  private readonly refreshTokens = new Map<string, { kind: 'tt' | 'ad'; ids: string[] }>();
  private readonly faults = new Map<TikTokEndpoint, { code: number; status: number }[]>();
  private readonly revoked = new Set<string>();
  private readonly down = new Set<Product>();
  private readonly log: {
    endpoint: TikTokEndpoint;
    query: Record<string, string>;
    body: unknown;
  }[] = [];
  private readonly now: () => Date;
  private readonly appId: string;
  private readonly appSecret: string;

  constructor(o: { appId: string; appSecret: string; now?: () => Date }) {
    this.appId = o.appId;
    this.appSecret = o.appSecret;
    this.now = o.now ?? (() => new Date());
  }

  readonly fetch: typeof globalThis.fetch = (input, init) =>
    Promise.resolve(this.handle(new URL(String(input)), init));

  // ---- setup ----
  addBusinessAccount(o: { username?: string; scopes?: string[] } = {}) {
    const businessId = this.id();
    this.accounts.set(businessId, {
      username: o.username ?? `user${businessId.slice(-4)}`,
      scopes: o.scopes ?? ['user.info.basic', 'video.list', 'comment.list', 'comment.list.manage'],
    });
    return { businessId, authCode: this.authCode('tt', businessId) };
  }
  addVideo(businessId: string, o: { createdAtSec?: number; shareUrl?: string } = {}) {
    const itemId = this.id();
    this.videos.set(itemId, {
      businessId,
      createdAtSec: o.createdAtSec ?? Math.floor(this.now().getTime() / 1000),
      shareUrl:
        o.shareUrl ??
        `https://www.tiktok.com/@${this.accounts.get(businessId)?.username}/video/${itemId}`,
    });
    return { itemId };
  }
  addComment(
    itemId: string,
    o: {
      text: string;
      createdAtSec: number;
      parentId?: string;
      userId?: string;
      username?: string;
      hidden?: boolean;
    },
  ) {
    const id = this.id();
    this.organic.set(id, this.comment(id, itemId, o.text, o.createdAtSec, o));
    return { commentId: id };
  }
  addAdvertiser(o: { name?: string } = {}) {
    const advertiserId = this.id();
    this.advertisers.set(advertiserId, o.name ?? `Advertiser ${advertiserId.slice(-4)}`);
    return { advertiserId, authCode: this.authCode('ad', advertiserId) };
  }
  addAdComment(
    advertiserId: string,
    o: {
      adId: string;
      itemId: string;
      text: string;
      createdAt: Date;
      parentId?: string;
      commentId?: string;
      hidden?: boolean;
    },
  ) {
    const id = o.commentId ?? this.id();
    this.ads.set(id, {
      ...this.comment(id, o.itemId, o.text, Math.floor(o.createdAt.getTime() / 1000), o),
      advertiserId,
      adId: o.adId,
    });
    return { commentId: id };
  }
  /** Ads tokens expire after 24h and come with a refresh token (V12 alternative). */
  withExpiringAdsTokens() {
    this.expiringAds = true;
    return this;
  }
  /** Runs `fn` once, just before the next non-first page of any list is served. */
  mutateBetweenPages(fn: () => void) {
    this.beforeNextPage = fn;
  }

  // ---- state ----
  deleteComment(commentId: string) {
    for (const m of [this.organic, this.ads]) {
      const c = m.get(commentId);
      if (c) c.deleted = true;
    }
  }
  commentState(commentId: string): State | undefined {
    const c = this.organic.get(commentId) ?? this.ads.get(commentId);
    return c && (c.deleted ? 'DELETED' : c.hidden ? 'HIDDEN' : 'PUBLIC');
  }
  replies(commentId: string) {
    return [...(this.replyLog.get(commentId) ?? [])];
  }

  // ---- faults ----
  throttleNext(endpoint: TikTokEndpoint, times: number) {
    this.queue(endpoint, { code: 40100 }, times);
  }
  failNext(endpoint: TikTokEndpoint, o: { code?: number; httpStatus?: number; times?: number }) {
    this.queue(endpoint, { code: o.code ?? 50000, httpStatus: o.httpStatus }, o.times ?? 1);
  }
  revokeScope(businessIdOrAdvertiserId: string, endpoint: TikTokEndpoint) {
    this.revoked.add(`${businessIdOrAdvertiserId}:${endpoint}`);
  }
  expireAccessToken(token: string) {
    const t = this.tokens.get(token);
    if (t) t.expired = true;
  }
  outage(product: Product, on: boolean) {
    if (on) this.down.add(product);
    else this.down.delete(product);
  }

  calls(endpoint?: TikTokEndpoint) {
    return this.log.filter((c) => endpoint === undefined || c.endpoint === endpoint);
  }

  // ---- internals ----
  private id() {
    return String(this.nextId++);
  }
  private authCode(kind: 'tt' | 'ad', id: string) {
    const code = `${kind}_code_${this.id()}`;
    this.authCodes.set(code, { kind, id });
    return code;
  }
  private comment(
    id: string,
    itemId: string,
    text: string,
    createdAtSec: number,
    o: Partial<Comment>,
  ): Comment {
    return {
      id,
      itemId,
      text,
      createdAtSec,
      ...(o.parentId !== undefined && { parentId: o.parentId }),
      userId: o.userId ?? this.id(),
      username: o.username ?? 'commenter',
      hidden: o.hidden ?? false,
      deleted: false,
    };
  }
  private queue(
    endpoint: TikTokEndpoint,
    f: { code: number; httpStatus?: number | undefined },
    times: number,
  ) {
    const q = this.faults.get(endpoint) ?? [];
    for (let i = 0; i < times; i++) q.push({ code: f.code, status: f.httpStatus ?? 200 });
    this.faults.set(endpoint, q);
  }
  private reply(status: number, code: number, data: unknown = {}) {
    return new Response(
      JSON.stringify({
        code,
        message: code === 0 ? 'OK' : 'error',
        request_id: `req${this.id()}`,
        data,
      }),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }

  private handle(url: URL, init?: RequestInit): Response {
    const path = url.pathname.replace(/^\/open_api\/v1\.3\//, '');
    const endpoint = (Object.keys(TIKTOK_ENDPOINTS) as TikTokEndpoint[]).find(
      (k) => TIKTOK_ENDPOINTS[k] === path,
    );
    if (!endpoint) return new Response('not found', { status: 404 });
    const query = Object.fromEntries(url.searchParams);
    let body: Obj | undefined;
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Obj;
    this.log.push({ endpoint, query, body });
    const token = new Headers(init?.headers).get('access-token') ?? undefined;
    try {
      if (this.down.has(productOf(endpoint))) throw new Fail(50000, 503);
      const fault = this.faults.get(endpoint)?.shift();
      if (fault) throw new Fail(fault.code, fault.status);
      const rec = NO_TOKEN.has(endpoint)
        ? undefined
        : this.authenticate(endpoint, token, query, body ?? {});
      return this.reply(200, 0, this.route(endpoint, query, body ?? {}, rec));
    } catch (e) {
      if (e instanceof Fail) return this.reply(e.status, e.code);
      throw e;
    }
  }

  private authenticate(endpoint: TikTokEndpoint, token: string | undefined, q: Obj, b: Obj): Token {
    const rec = token === undefined ? undefined : this.tokens.get(token);
    if (!rec) throw new Fail(40104);
    if (rec.expired || (rec.expiresAtMs !== undefined && this.now().getTime() >= rec.expiresAtMs)) {
      throw new Fail(40105);
    }
    if (rec.kind !== (productOf(endpoint) === 'accounts' ? 'tt' : 'ad')) throw new Fail(40104);
    const param = str(
      q[rec.kind === 'tt' ? 'business_id' : 'advertiser_id'] ??
        b[rec.kind === 'tt' ? 'business_id' : 'advertiser_id'],
    );
    if (param !== undefined && !rec.ids.includes(param)) throw new Fail(40001);
    for (const id of param === undefined ? rec.ids : [param]) {
      if (this.revoked.has(`${id}:${endpoint}`)) throw new Fail(40001);
    }
    return rec;
  }

  /** Runs the mutateBetweenPages hook (once) before any page after the first. */
  private beforePage(isNext: boolean) {
    const fn = this.beforeNextPage;
    if (isNext && fn) {
      this.beforeNextPage = undefined;
      fn();
    }
  }

  private checkApp(id: unknown, secret: unknown) {
    if (id !== this.appId || secret !== this.appSecret) throw new Fail(40001);
  }

  private issue(kind: 'tt' | 'ad', ids: string[], ttl: number | undefined) {
    const access = `${kind}_at_${this.id()}`;
    this.tokens.set(access, {
      kind,
      ids,
      expired: false,
      ...(ttl !== undefined && { expiresAtMs: this.now().getTime() + ttl * 1000 }),
    });
    let refresh: string | undefined;
    if (ttl !== undefined) {
      refresh = `${kind}_rt_${this.id()}`;
      this.refreshTokens.set(refresh, { kind, ids });
    }
    return { access, refresh };
  }

  private route(endpoint: TikTokEndpoint, q: Obj, b: Obj, t: Token | undefined): Obj {
    const need = (v: unknown) => str(v) ?? this.bad();
    switch (endpoint) {
      case 'ttToken': {
        this.checkApp(b.client_id, b.client_secret);
        const code = this.authCodes.get(need(b.auth_code));
        if (code?.kind !== 'tt') throw new Fail(40002);
        this.authCodes.delete(need(b.auth_code));
        const { access, refresh } = this.issue('tt', [code.id], 86400);
        return this.ttTokens(access, refresh!, code.id);
      }
      case 'ttRefresh': {
        this.checkApp(b.client_id, b.client_secret);
        const old = this.refreshTokens.get(need(b.refresh_token));
        if (old?.kind !== 'tt') throw new Fail(40102);
        this.refreshTokens.delete(need(b.refresh_token));
        for (const [k, v] of this.tokens)
          if (v.kind === 'tt' && v.ids[0] === old.ids[0]) this.tokens.delete(k);
        const { access, refresh } = this.issue('tt', old.ids, 86400);
        return this.ttTokens(access, refresh!, old.ids[0]!);
      }
      case 'ttRevoke': {
        for (const [k, v] of this.tokens) if (v === t) this.tokens.delete(k);
        return {};
      }
      case 'businessGet': {
        const id = str(q.business_id) ?? t!.ids[0]!;
        const a = this.accounts.get(id) ?? this.bad();
        return { business_id: id, username: a.username, display_name: a.username };
      }
      case 'businessVideoList': {
        const id = str(q.business_id) ?? t!.ids[0]!;
        this.beforePage(Number(q.cursor ?? 0) > 0);
        const all = [...this.videos.entries()]
          .filter(([, v]) => v.businessId === id)
          .sort(([, a], [, b2]) => b2.createdAtSec - a.createdAtSec);
        const { slice, cursor, hasMore } = this.cursorPage(all, q, 20);
        return {
          videos: slice.map(([itemId, v]) => ({
            item_id: itemId,
            create_time: v.createdAtSec,
            share_url: v.shareUrl,
            comments: [...this.organic.values()].filter((c) => c.itemId === itemId && !c.deleted)
              .length,
          })),
          cursor,
          has_more: hasMore,
        };
      }
      case 'businessCommentList':
      case 'businessReplyList': {
        const bid = str(q.business_id) ?? t!.ids[0]!;
        const video = need(q.video_id);
        if (this.videos.get(video)?.businessId !== bid) throw new Fail(40002);
        const parent = endpoint === 'businessReplyList' ? need(q.comment_id) : undefined;
        this.beforePage(Number(q.cursor ?? 0) > 0);
        const all = [...this.organic.values()]
          .filter((c) => c.itemId === video && !c.deleted && c.parentId === parent)
          .sort(newestFirst);
        const { slice, cursor, hasMore } = this.cursorPage(all, q, 30);
        return { comments: slice.map((c) => this.organicJson(c)), cursor, has_more: hasMore };
      }
      case 'businessCommentHide': {
        const c = this.liveOrganic(b.comment_id);
        const action = b.action;
        if (action !== 'HIDE' && action !== 'UNHIDE') throw new Fail(40002);
        c.hidden = action === 'HIDE';
        return {};
      }
      case 'businessCommentDelete':
        this.liveOrganic(b.comment_id).deleted = true;
        return {};
      case 'businessReplyCreate': {
        const c = this.liveOrganic(b.comment_id);
        return { comment_id: this.addReply(c.id, need(b.text)) };
      }
      case 'adOauthToken': {
        this.checkApp(b.app_id, b.secret);
        const code = this.authCodes.get(need(b.auth_code));
        if (code?.kind !== 'ad') throw new Fail(40002);
        this.authCodes.delete(need(b.auth_code));
        const { access, refresh } = this.issue(
          'ad',
          [code.id],
          this.expiringAds ? 86400 : undefined,
        );
        return {
          access_token: access,
          advertiser_ids: [code.id],
          ...(refresh && {
            expires_in: 86400,
            refresh_token: refresh,
            refresh_token_expires_in: 31536000,
          }),
        };
      }
      case 'adOauthRefresh': {
        this.checkApp(b.app_id, b.secret);
        const old = this.refreshTokens.get(need(b.refresh_token));
        if (old?.kind !== 'ad') throw new Fail(40102);
        this.refreshTokens.delete(need(b.refresh_token));
        const { access, refresh } = this.issue('ad', old.ids, 86400);
        return {
          access_token: access,
          refresh_token: refresh,
          expires_in: 86400,
          refresh_token_expires_in: 31536000,
        };
      }
      case 'adAdvertiserGet':
        this.checkApp(q.app_id, q.secret);
        return {
          list: t!.ids.map((id) => ({
            advertiser_id: id,
            advertiser_name: this.advertisers.get(id),
          })),
        };
      case 'adCommentList':
        return this.adList(need(q.advertiser_id), q);
      case 'adCommentStatusUpdate': {
        const op = b.operation;
        if (op !== 'HIDDEN' && op !== 'PUBLIC') throw new Fail(40002);
        const cs = this.liveAds(b);
        for (const c of cs) c.hidden = op === 'HIDDEN';
        return {};
      }
      case 'adCommentDelete':
        for (const c of this.liveAds(b)) c.deleted = true;
        return {};
      case 'adCommentPost': {
        const c = this.liveAds({ ...b, comment_ids: [b.comment_id] })[0]!;
        return { comment_id: this.addReply(c.id, need(b.text)) };
      }
    }
  }

  private bad(): never {
    throw new Fail(40002);
  }
  private max(q: Obj, limit: number) {
    const n = q.max_count === undefined ? limit : Number(q.max_count);
    if (!Number.isInteger(n) || n < 1 || n > limit) throw new Fail(40002);
    return n;
  }
  private cursorPage<T>(all: T[], q: Obj, limit: number) {
    const start = Number(q.cursor ?? 0) || 0;
    const n = this.max(q, limit);
    const slice = all.slice(start, start + n);
    return { slice, cursor: start + slice.length, hasMore: start + slice.length < all.length };
  }
  private ttTokens(access: string, refresh: string, businessId: string) {
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 86400,
      refresh_token_expires_in: 31536000,
      open_id: businessId,
      scope: this.accounts.get(businessId)?.scopes.join(','),
    };
  }
  private organicJson(c: Comment): Obj {
    return {
      comment_id: c.id,
      video_id: c.itemId,
      text: c.text,
      create_time: c.createdAtSec,
      user_id: c.userId,
      username: c.username,
      display_name: c.username,
      ...(c.parentId !== undefined && { parent_comment_id: c.parentId }),
      reply_count: [...this.organic.values()].filter((r) => r.parentId === c.id && !r.deleted)
        .length,
      status: c.hidden ? 'HIDDEN' : 'PUBLIC',
    };
  }
  private liveOrganic(id: unknown): Comment {
    const c = typeof id === 'string' ? this.organic.get(id) : undefined;
    if (!c || c.deleted) throw new Fail(40400);
    return c;
  }
  private liveAds(b: Obj): Comment[] {
    const ids = Array.isArray(b.comment_ids) ? (b.comment_ids as unknown[]) : this.bad();
    return ids.map((id) => {
      const c = typeof id === 'string' ? this.ads.get(id) : undefined;
      if (!c || c.deleted || c.advertiserId !== b.advertiser_id) throw new Fail(40400);
      return c;
    });
  }
  private addReply(commentId: string, text: string) {
    const log = this.replyLog.get(commentId) ?? [];
    log.push({ text });
    this.replyLog.set(commentId, log);
    return this.id();
  }

  private adList(advertiserId: string, q: Obj): Obj {
    const pageNo = q.page === undefined ? 1 : Number(q.page);
    const size = q.page_size === undefined ? 10 : Number(q.page_size);
    if (
      !Number.isInteger(pageNo) ||
      pageNo < 1 ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 100
    ) {
      throw new Fail(40002);
    }
    this.beforePage(pageNo > 1);
    const types: unknown =
      q.comment_type === undefined ? undefined : JSON.parse(String(q.comment_type));
    const field = {
      AD_ID: 'adId',
      COMMENT_ID: 'id',
      USER_NAME: 'username',
      TIKTOK_ITEM_ID: 'itemId',
    }[String(q.search_field)] as keyof Comment | undefined;
    const date = (c: Comment) => new Date(c.createdAtSec * 1000).toISOString().slice(0, 10);
    const all = [...this.ads.values()]
      .filter((c) => c.advertiserId === advertiserId && !c.deleted)
      .filter((c) => q.start_time === undefined || date(c) >= String(q.start_time))
      .filter((c) => q.end_time === undefined || date(c) <= String(q.end_time))
      .filter(
        (c) =>
          !Array.isArray(types) || types.includes(c.parentId === undefined ? 'COMMENT' : 'REPLY'),
      )
      .filter(
        (c) =>
          !field ||
          q.search_value === undefined ||
          String(c[field]).includes(String(q.search_value)),
      )
      .sort(q.sort_type === 'ASC' ? (a, b2) => -newestFirst(a, b2) : newestFirst);
    const slice = all.slice((pageNo - 1) * size, pageNo * size);
    return {
      comments: slice.map((c) => ({
        comment_id: c.id,
        ad_id: c.adId,
        tiktok_item_id: c.itemId,
        ...(c.parentId !== undefined && { original_comment_id: c.parentId }),
        content: c.text,
        create_time: new Date(c.createdAtSec * 1000).toISOString().slice(0, 19).replace('T', ' '),
        comment_status: c.hidden ? 'HIDDEN' : 'PUBLIC',
        user_id: c.userId,
        user_name: c.username,
      })),
      page_info: {
        page: pageNo,
        page_size: size,
        total_number: all.length,
        total_page: Math.ceil(all.length / size),
      },
    };
  }
}
