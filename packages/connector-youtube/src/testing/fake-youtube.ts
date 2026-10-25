// Stateful fake of the YouTube Data API v3 (commentThreads, comments, channels,
// comments.setModerationStatus) and Google's OAuth token endpoints, as a
// `fetch` for `createSafeHttp({ fetch })`. It follows the documented API; the
// behaviours marked "assumed" are still to be checked against a real project.

export type FakeCommentStatus =
  | 'published'
  | 'heldForReview'
  | 'likelySpam'
  | 'rejected'
  | 'deleted';

export interface FakeComment {
  id: string;
  parentId: string | null;
  videoId: string;
  authorChannelId: string | null;
  textOriginal: string;
  status: FakeCommentStatus;
  /** The status last set through setModerationStatus; null when only the platform set it. */
  apiStatus: 'heldForReview' | 'published' | 'rejected' | null;
  publishedAt: Date;
  updatedAt: Date;
}

export interface FakeCall {
  readonly method: string;
  readonly query: Readonly<Record<string, string>>;
  readonly units: number;
}

type Obj = Record<string, unknown>;

/** Documented unit costs (determine_quota_cost); kept independent of the connector's table. */
const UNITS: Readonly<Record<string, number>> = {
  'commentThreads.list': 1,
  'comments.list': 1,
  'channels.list': 1,
  'comments.setModerationStatus': 50,
};
const ROUTES: Readonly<Record<string, { method: string; http: 'GET' | 'POST' }>> = {
  commentThreads: { method: 'commentThreads.list', http: 'GET' },
  comments: { method: 'comments.list', http: 'GET' },
  channels: { method: 'channels.list', http: 'GET' },
  'comments/setModerationStatus': { method: 'comments.setModerationStatus', http: 'POST' },
};
const FORCE_SSL = 'https://www.googleapis.com/auth/youtube.force-ssl';
const MAX_MODERATION_IDS = 50;
/** Assumed: the thread resource carries at most this many replies inline. */
const INLINE_REPLIES = 5;
const ACCESS_TTL_SEC = 3599;

/** Calendar date in America/Los_Angeles (inline copy: the fake must not depend on `comments`). */
export function pacificDayKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

const googleError = (status: number, reason: string, message = 'fake error'): Response =>
  Response.json(
    { error: { code: status, message, errors: [{ message, domain: 'youtube.api', reason }] } },
    { status },
  );
const oauthError = (status: number, error: string): Response =>
  Response.json({ error, error_description: 'fake error' }, { status });

class Pager {
  constructor(
    readonly offset: number,
    readonly size: number,
  ) {}
  static from(q: URLSearchParams, def: number): Pager | Response {
    const raw = q.get('maxResults');
    const size = raw === null ? def : Number(raw);
    if (!Number.isInteger(size) || size < 1 || size > 100) {
      return googleError(400, 'invalidMaxResults');
    }
    const token = q.get('pageToken');
    if (token === null) return new Pager(0, size);
    const m = /^p(\d{1,6})$/.exec(token);
    if (!m) return googleError(400, 'invalidPageToken');
    return new Pager(Number(m[1]), size);
  }
  page<T>(all: readonly T[]): { items: T[]; nextPageToken?: string } {
    const end = this.offset + this.size;
    return {
      items: all.slice(this.offset, end),
      ...(end < all.length && { nextPageToken: `p${end}` }),
    };
  }
}

export class FakeYouTube {
  readonly calls: FakeCall[] = [];
  dailyLimit: number;
  channel: { id: string; title: string } | null;
  private used = 0;
  private day: string;
  private seq = 0;
  private readonly videos = new Map<string, { commentsDisabled: boolean }>();
  private readonly comments = new Map<string, FakeComment>();
  private readonly banned = new Set<string>();
  private readonly accessTokens = new Map<string, { expiresAtMs: number }>();
  private readonly refreshTokens = new Set<string>();
  private readonly authCodes = new Map<string, { scopes: string[] }>();
  private readonly nextFaults: { reason: string; status: number }[] = [];
  private readonly methodFaults = new Map<string, { reason: string; status: number }>();
  private readonly clientId: string;
  private readonly clientSecret: string;
  readonly clock: () => number;

  constructor(o: {
    clientId: string;
    clientSecret: string;
    channel?: { id: string; title: string } | null;
    clock?: () => number;
    dailyLimit?: number;
  }) {
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
    this.clock = o.clock ?? Date.now;
    this.channel = o.channel === undefined ? { id: this.channelId(), title: 'Channel' } : o.channel;
    this.dailyLimit = o.dailyLimit ?? 10_000;
    this.day = pacificDayKey(this.clock());
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    return this.handle(url, method, headers, body);
  };

  // ---- setup ----
  /** The connected channel's id (the owner of every video here). */
  get ownerChannelId(): string | null {
    return this.channel?.id ?? null;
  }
  addVideo(o: { id?: string; commentsDisabled?: boolean } = {}): string {
    const id = o.id ?? `v${this.next().padStart(10, '0')}`;
    this.videos.set(id, { commentsDisabled: o.commentsDisabled ?? false });
    return id;
  }
  /** A top-level comment (thread) or, with `parentId`, a reply. Banned authors' comments arrive rejected. */
  addComment(o: {
    videoId?: string;
    parentId?: string;
    id?: string;
    authorChannelId?: string | null;
    text: string;
    status?: FakeCommentStatus;
    publishedAt?: Date;
  }): string {
    const parent = o.parentId === undefined ? undefined : this.comments.get(o.parentId);
    if (o.parentId !== undefined && !parent) throw new Error('unknown parent');
    const videoId = parent?.videoId ?? o.videoId;
    if (videoId === undefined || !this.videos.has(videoId)) throw new Error('unknown video');
    const id =
      o.id ??
      (parent
        ? `${parent.id}.${this.next().padStart(12, '0')}`
        : `Ugz${this.next().padStart(12, '0')}`);
    const author = o.authorChannelId === undefined ? this.channelId() : o.authorChannelId;
    const at = o.publishedAt ?? new Date(this.clock());
    this.comments.set(id, {
      id,
      parentId: parent?.id ?? null,
      videoId,
      authorChannelId: author,
      textOriginal: o.text,
      status: author !== null && this.banned.has(author) ? 'rejected' : (o.status ?? 'published'),
      apiStatus: null,
      publishedAt: at,
      updatedAt: at,
    });
    return id;
  }
  comment(id: string): FakeComment | undefined {
    return this.comments.get(id);
  }
  /** Platform-side change (author edit, deletion, auto-hold); not an API moderation. */
  updateComment(id: string, patch: Partial<Pick<FakeComment, 'textOriginal' | 'status'>>): void {
    const c = this.comments.get(id);
    if (!c) throw new Error('unknown comment');
    Object.assign(c, patch, { updatedAt: new Date(this.clock()) });
  }
  isBanned(authorChannelId: string): boolean {
    return this.banned.has(authorChannelId);
  }
  /** An authorization code for the consent step. Scopes are Google scope URLs. */
  authorize(o: { scopes?: string[] } = {}): string {
    const code = `4/fake-code-${this.next()}`;
    this.authCodes.set(code, { scopes: o.scopes ?? [FORCE_SSL] });
    return code;
  }
  issueAccessToken(): string {
    const t = `ya29.fake-${this.next()}`;
    this.accessTokens.set(t, { expiresAtMs: this.clock() + ACCESS_TTL_SEC * 1000 });
    return t;
  }
  expireAccessToken(t: string): void {
    this.accessTokens.delete(t);
  }

  // ---- quota and faults ----
  get unitsUsed(): number {
    this.rollDay();
    return this.used;
  }
  /** Google answers `quotaExceeded` once a call would take the day past `units`. */
  exhaustQuotaAt(units: number): void {
    this.dailyLimit = units;
  }
  failNext(reason: string, status: number): void {
    this.nextFaults.push({ reason, status });
  }
  /** Every call to `method` fails until `clearFaults()`. */
  failOn(method: string, reason: string, status: number): void {
    this.methodFaults.set(method, { reason, status });
  }
  clearFaults(): void {
    this.nextFaults.length = 0;
    this.methodFaults.clear();
  }

  // ---- dispatch ----
  private handle(url: URL, method: string, headers: Headers, body: string): Response {
    if (url.hostname === 'oauth2.googleapis.com') return this.oauth(url, method, headers, body);
    const path = url.pathname.replace(/^\/youtube\/v3\//, '');
    const route = url.hostname === 'www.googleapis.com' ? ROUTES[path] : undefined;
    if (!route || !url.pathname.startsWith('/youtube/v3/')) return googleError(404, 'notFound');
    const query = Object.fromEntries(url.searchParams);
    if (route.http !== method) {
      this.calls.push({ method: route.method, query, units: 1 });
      this.charge(1);
      return googleError(405, 'methodNotAllowed');
    }
    const units = UNITS[route.method]!;
    this.rollDay();
    if (this.used + units > this.dailyLimit) {
      this.calls.push({ method: route.method, query, units: 0 });
      return Response.json(
        {
          error: {
            code: 403,
            message: 'quota',
            errors: [{ message: 'quota', domain: 'youtube.quota', reason: 'quotaExceeded' }],
          },
        },
        { status: 403 },
      );
    }
    this.charge(units);
    this.calls.push({ method: route.method, query, units });
    const fault = this.nextFaults.shift() ?? this.methodFaults.get(route.method);
    if (fault) return googleError(fault.status, fault.reason);
    const auth = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '');
    const tok = auth ? this.accessTokens.get(auth[1]!) : undefined;
    if (!tok || tok.expiresAtMs <= this.clock()) return googleError(401, 'authError');
    const q = url.searchParams;
    switch (route.method) {
      case 'commentThreads.list':
        return this.listThreads(q);
      case 'comments.list':
        return this.listComments(q);
      case 'channels.list':
        return this.listChannels(q);
      default:
        return this.setModerationStatus(q);
    }
  }

  private listChannels(q: URLSearchParams): Response {
    if (q.get('mine') !== 'true') return googleError(400, 'missingRequiredParameter');
    const items = this.channel
      ? [{ kind: 'youtube#channel', id: this.channel.id, snippet: { title: this.channel.title } }]
      : [];
    return Response.json({ kind: 'youtube#channelListResponse', items });
  }

  private listThreads(q: URLSearchParams): Response {
    const ids = q.get('id');
    const parts = (q.get('part') ?? '').split(',');
    const withReplies = parts.includes('replies');
    if (ids !== null) {
      const items = ids
        .split(',')
        .map((id) => this.comments.get(id))
        .filter((c): c is FakeComment => !!c && c.parentId === null && this.listable(c, true))
        .map((c) => this.thread(c, withReplies));
      return Response.json({ kind: 'youtube#commentThreadListResponse', items });
    }
    const status = q.get('moderationStatus') ?? 'published';
    if (!['published', 'heldForReview', 'likelySpam'].includes(status)) {
      return googleError(400, 'invalidModerationStatus');
    }
    const channelId = q.get('allThreadsRelatedToChannelId');
    const videoId = q.get('videoId');
    let videos: string[];
    if (channelId !== null) {
      if (channelId !== this.ownerChannelId) return googleError(404, 'channelNotFound');
      videos = [...this.videos].filter(([, v]) => !v.commentsDisabled).map(([id]) => id);
    } else if (videoId !== null) {
      const v = this.videos.get(videoId);
      if (!v) return googleError(404, 'videoNotFound');
      if (v.commentsDisabled) return googleError(403, 'commentsDisabled');
      videos = [videoId];
    } else {
      return googleError(400, 'missingRequiredParameter');
    }
    const pager = Pager.from(q, 20);
    if (pager instanceof Response) return pager;
    const top = [...this.comments.values()]
      .filter((c) => c.parentId === null && videos.includes(c.videoId) && c.status === status)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || (a.id < b.id ? 1 : -1));
    const page = pager.page(top);
    return Response.json({
      kind: 'youtube#commentThreadListResponse',
      ...page,
      items: page.items.map((c) => this.thread(c, withReplies)),
    });
  }

  private listComments(q: URLSearchParams): Response {
    const ids = q.get('id');
    const parentId = q.get('parentId');
    if (ids !== null) {
      // Assumed (c): rejected and deleted comments are omitted; held ones carry moderationStatus.
      const items = ids
        .split(',')
        .map((id) => this.comments.get(id))
        .filter((c): c is FakeComment => !!c && this.listable(c, true))
        .map((c) => this.resource(c));
      return Response.json({ kind: 'youtube#commentListResponse', items });
    }
    if (parentId === null) return googleError(400, 'missingRequiredParameter');
    const pager = Pager.from(q, 20);
    if (pager instanceof Response) return pager;
    const page = pager.page(this.replies(parentId));
    return Response.json({
      kind: 'youtube#commentListResponse',
      ...page,
      items: page.items.map((c) => this.resource(c)),
    });
  }

  private setModerationStatus(q: URLSearchParams): Response {
    const ids = (q.get('id') ?? '').split(',').filter(Boolean);
    const status = q.get('moderationStatus');
    const ban = q.get('banAuthor') === 'true';
    if (ids.length === 0) return googleError(400, 'missingRequiredParameter');
    if (ids.length > MAX_MODERATION_IDS) return googleError(400, 'invalidValue');
    if (status !== 'heldForReview' && status !== 'published' && status !== 'rejected') {
      return googleError(400, 'invalidModerationStatus');
    }
    if (ban && status !== 'rejected') return googleError(400, 'banWithoutReject');
    const targets = ids.map((id) => this.comments.get(id));
    // Assumed (b): one missing id fails the whole call.
    if (targets.some((c) => !c || c.status === 'deleted')) {
      return googleError(404, 'commentNotFound');
    }
    const found = targets as FakeComment[];
    if (
      status === 'heldForReview' &&
      found.some((c) => c.apiStatus === 'published' || c.apiStatus === 'rejected')
    ) {
      return googleError(400, 'operationNotSupported');
    }
    const now = new Date(this.clock());
    for (const c of found) {
      c.status = status;
      c.apiStatus = status;
      c.updatedAt = now;
      if (ban && c.authorChannelId !== null) this.banned.add(c.authorChannelId);
    }
    return new Response(null, { status: 204 });
  }

  // ---- OAuth ----
  private oauth(url: URL, method: string, headers: Headers, body: string): Response {
    const name = url.pathname === '/token' ? 'oauth.token' : 'oauth.revoke';
    this.calls.push({ method: name, query: {}, units: 0 });
    if (method !== 'POST') return oauthError(405, 'invalid_request');
    if (!(headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) {
      return oauthError(400, 'invalid_request');
    }
    const f = new URLSearchParams(body);
    if (url.pathname === '/revoke') {
      const t = f.get('token') ?? '';
      const known = this.accessTokens.delete(t) || this.refreshTokens.delete(t);
      return known ? new Response('{}', { status: 200 }) : oauthError(400, 'invalid_token');
    }
    if (url.pathname !== '/token') return oauthError(404, 'not_found');
    if (f.get('client_id') !== this.clientId || f.get('client_secret') !== this.clientSecret) {
      return oauthError(401, 'invalid_client');
    }
    const grant = f.get('grant_type');
    if (grant === 'authorization_code') {
      const code = this.authCodes.get(f.get('code') ?? '');
      if (!code || !f.get('code_verifier')) return oauthError(400, 'invalid_grant');
      this.authCodes.delete(f.get('code')!);
      const refresh = `1//fake-refresh-${this.next()}`;
      this.refreshTokens.add(refresh);
      return Response.json({
        access_token: this.issueAccessToken(),
        expires_in: ACCESS_TTL_SEC,
        refresh_token: refresh,
        scope: code.scopes.join(' '),
        token_type: 'Bearer',
      });
    }
    if (grant === 'refresh_token') {
      if (!this.refreshTokens.has(f.get('refresh_token') ?? '')) {
        return oauthError(400, 'invalid_grant');
      }
      return Response.json({
        access_token: this.issueAccessToken(),
        expires_in: ACCESS_TTL_SEC,
        scope: FORCE_SSL,
        token_type: 'Bearer',
      });
    }
    return oauthError(400, 'unsupported_grant_type');
  }

  // ---- helpers ----
  private listable(c: FakeComment, includeHeld: boolean): boolean {
    if (c.status === 'rejected' || c.status === 'deleted') return false;
    return includeHeld || c.status === 'published';
  }
  private replies(parentId: string): FakeComment[] {
    return [...this.comments.values()]
      .filter((c) => c.parentId === parentId && c.status === 'published')
      .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  }
  private resource(c: FakeComment): Obj {
    return {
      kind: 'youtube#comment',
      id: c.id,
      snippet: {
        channelId: this.ownerChannelId,
        videoId: c.videoId,
        textDisplay: c.textOriginal,
        textOriginal: c.textOriginal,
        ...(c.parentId !== null && { parentId: c.parentId }),
        authorDisplayName: 'Viewer',
        ...(c.authorChannelId !== null && { authorChannelId: { value: c.authorChannelId } }),
        ...(c.status !== 'published' && { moderationStatus: c.status }),
        likeCount: 0,
        publishedAt: c.publishedAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      },
    };
  }
  private thread(c: FakeComment, withReplies: boolean): Obj {
    const replies = this.replies(c.id);
    return {
      kind: 'youtube#commentThread',
      id: c.id,
      snippet: {
        channelId: this.ownerChannelId,
        videoId: c.videoId,
        topLevelComment: this.resource(c),
        canReply: true,
        totalReplyCount: replies.length,
        isPublic: true,
      },
      ...(withReplies &&
        replies.length > 0 && {
          replies: { comments: replies.slice(0, INLINE_REPLIES).map((r) => this.resource(r)) },
        }),
    };
  }
  private rollDay(): void {
    const day = pacificDayKey(this.clock());
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
  }
  private charge(units: number): void {
    this.rollDay();
    this.used += units;
  }
  private next(): string {
    this.seq += 1;
    return this.seq.toString(36);
  }
  private channelId(): string {
    return `UC${this.next().padStart(22, '0')}`;
  }
}
