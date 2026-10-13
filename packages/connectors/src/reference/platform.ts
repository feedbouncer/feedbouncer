// A fake platform with the behaviors real ones have and connectors get wrong:
// rotating refresh tokens that die the moment they are answered, single-use
// PKCE-bound codes, expiring access tokens, keyset pagination, idempotent
// actions, throttling and HMAC-signed webhooks. Synchronous and in-memory so
// the conformance suite can drive it deterministically.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { ModerationAction } from '../types.js';

export class PlatformError extends Error {
  override name = 'PlatformError';
  constructor(
    readonly status: 400 | 401 | 404 | 429 | 503,
    readonly error: string,
    readonly retryAfterSec?: number,
  ) {
    super(`${status} ${error}`);
  }
}

export interface RefComment {
  readonly id: string;
  readonly sourceId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly body: string;
  readonly postedAt: number;
  state: 'visible' | 'hidden' | 'deleted';
}

interface Source {
  readonly accountId: string;
  readonly comments: Map<string, RefComment>;
}
interface AccessGrant {
  readonly accountId: string;
  expiresAt: number;
  revoked: boolean;
}
interface PendingCode {
  readonly accountId: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
  used: boolean;
}

const CODE_TTL_MS = 60_000;
const token = (prefix: string) => `${prefix}${randomBytes(24).toString('base64url')}`;

export class InMemoryPlatform {
  readonly #accounts = new Set<string>();
  readonly #sources = new Map<string, Source>();
  readonly #access = new Map<string, AccessGrant>();
  readonly #refresh = new Map<string, { accountId: string; live: boolean }>();
  readonly #codes = new Map<string, PendingCode>();
  readonly #banned = new Set<string>();
  readonly #issued: string[] = [];
  readonly #calls = { token: 0, refresh: 0, read: 0, act: 0 };
  #throttle: number | null = null;

  constructor(
    private readonly opts: {
      clock: Clock;
      rotateRefreshTokens: boolean;
      accessTokenTtlMs: number;
      webhookSecret: string | null;
      redirectUri: string;
      /** Prefix for generated account ids; set when platforms share a database. */
      accountIdPrefix?: string;
    },
  ) {
    if (opts.webhookSecret) this.#issued.push(opts.webhookSecret);
  }

  // ---- test controls ----

  createAccount(): string {
    const id = `${this.opts.accountIdPrefix ?? 'acct'}-${this.#accounts.size + 1}`;
    this.#accounts.add(id);
    return id;
  }

  consent(authorizationUrl: URL, accountId: string): { code: string; state: string } {
    const q = authorizationUrl.searchParams;
    const state = q.get('state');
    const challenge = q.get('code_challenge');
    if (!this.#accounts.has(accountId) || !state || !challenge)
      throw new PlatformError(400, 'invalid_request');
    if (
      q.get('code_challenge_method') !== 'S256' ||
      q.get('redirect_uri') !== this.opts.redirectUri
    )
      throw new PlatformError(400, 'invalid_request');
    const code = this.#issue('ref_code_');
    this.#codes.set(code, {
      accountId,
      challenge,
      redirectUri: this.opts.redirectUri,
      expiresAt: this.opts.clock.now() + CODE_TTL_MS,
      used: false,
    });
    return { code, state };
  }

  seedSource(accountId: string): string {
    const id = `src-${this.#sources.size + 1}`;
    this.#sources.set(id, { accountId, comments: new Map() });
    return id;
  }

  seedComments(accountId: string, sourceId: string, n: number): string[] {
    const src = this.#source(accountId, sourceId);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const seq = src.comments.size + 1;
      const id = `c-${String(seq).padStart(6, '0')}`;
      src.comments.set(id, {
        id,
        sourceId,
        authorId: `user-${(seq % 3) + 1}`,
        authorName: `User ${(seq % 3) + 1}`,
        body: `comment ${seq}`,
        postedAt: this.opts.clock.now(),
        state: 'visible',
      });
      ids.push(id);
    }
    return ids;
  }

  deleteComment(sourceId: string, commentId: string): void {
    const c = this.#sources.get(sourceId)?.comments.get(commentId);
    if (c) c.state = 'deleted';
  }

  commentState(sourceId: string, commentId: string): 'visible' | 'hidden' | 'deleted' {
    const c = this.#sources.get(sourceId)?.comments.get(commentId);
    if (!c) throw new Error('unknown comment');
    return c.state;
  }

  expireAccessTokens(): void {
    for (const g of this.#access.values()) g.expiresAt = this.opts.clock.now() - 1;
  }

  revokeGrant(accountId: string): void {
    for (const g of this.#access.values()) if (g.accountId === accountId) g.revoked = true;
    for (const r of this.#refresh.values()) if (r.accountId === accountId) r.live = false;
  }

  throttleNext(retryAfterSec: number): void {
    this.#throttle = retryAfterSec;
  }

  calls(op: 'token' | 'refresh' | 'read' | 'act'): number {
    return this.#calls[op];
  }

  issuedSecrets(): string[] {
    return [...this.#issued];
  }

  signedDelivery(
    accountId: string,
    commentId: string,
    sourceId: string,
    /** `deliveryHeader` sets the UNSIGNED decoy header, used to prove replays are deduped on the signed body. */
    opts: { deliveryHeader?: string; tsSec?: number } = {},
  ): { headers: Record<string, string>; rawBody: Buffer } {
    if (!this.opts.webhookSecret) throw new Error('this platform does not sign webhooks');
    const ts = opts.tsSec ?? Math.floor(this.opts.clock.now() / 1000);
    const rawBody = Buffer.from(
      JSON.stringify({
        events: [{ account: accountId, source: sourceId, comment: commentId, ts }],
      }),
      'utf8',
    );
    const mac = createHmac('sha256', this.opts.webhookSecret)
      .update(`${ts}.`)
      .update(rawBody)
      .digest('hex');
    return {
      headers: {
        'x-ref-signature': `sha256=${mac}`,
        'x-ref-timestamp': String(ts),
        'x-ref-delivery': opts.deliveryHeader ?? randomBytes(8).toString('hex'),
      },
      rawBody,
    };
  }

  // ---- API used by the connector ----

  tokenEndpoint(
    grant:
      | { kind: 'code'; code: string; codeVerifier: string; redirectUri: string }
      | { kind: 'refresh'; refreshToken: string },
  ): { accessToken: string; expiresAt: number; refreshToken: string | null; accountId: string } {
    this.#calls.token++;
    const now = this.opts.clock.now();
    if (grant.kind === 'code') {
      const c = this.#codes.get(grant.code);
      const pkce = createHash('sha256').update(grant.codeVerifier).digest('base64url');
      if (
        !c ||
        c.used ||
        c.expiresAt <= now ||
        c.redirectUri !== grant.redirectUri ||
        c.challenge !== pkce
      )
        throw new PlatformError(400, 'invalid_grant');
      c.used = true;
      const refreshToken = this.#issue('ref_rt_');
      this.#refresh.set(refreshToken, { accountId: c.accountId, live: true });
      return { ...this.#newAccess(c.accountId), refreshToken, accountId: c.accountId };
    }
    this.#calls.refresh++;
    const r = this.#refresh.get(grant.refreshToken);
    if (!r?.live) throw new PlatformError(400, 'invalid_grant');
    let refreshToken: string | null = null;
    if (this.opts.rotateRefreshTokens) {
      r.live = false;
      refreshToken = this.#issue('ref_rt_');
      this.#refresh.set(refreshToken, { accountId: r.accountId, live: true });
    }
    return { ...this.#newAccess(r.accountId), refreshToken, accountId: r.accountId };
  }

  api<T>(accessToken: string, op: 'read' | 'act', fn: (accountId: string) => T): T {
    this.#calls[op]++;
    if (this.#throttle !== null) {
      const retryAfterSec = this.#throttle;
      this.#throttle = null;
      throw new PlatformError(429, 'rate_limited', retryAfterSec);
    }
    const g = this.#access.get(accessToken);
    if (!g || g.revoked || g.expiresAt <= this.opts.clock.now())
      throw new PlatformError(401, 'invalid_token');
    return fn(g.accountId);
  }

  listComments(
    accountId: string,
    sourceId: string,
    afterId: string | null,
    limit: number,
  ): { items: RefComment[]; next: string | null } {
    const live = [...this.#source(accountId, sourceId).comments.values()]
      .filter((c) => c.state !== 'deleted' && (afterId === null || c.id > afterId))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const items = live.slice(0, limit);
    const more = live.length > items.length;
    return { items, next: more ? (items.at(-1)?.id ?? null) : null };
  }

  getComment(accountId: string, sourceId: string, commentId: string): RefComment | null {
    const c = this.#source(accountId, sourceId).comments.get(commentId);
    return c && c.state !== 'deleted' ? c : null;
  }

  apply(
    accountId: string,
    sourceId: string,
    commentId: string,
    action: ModerationAction,
  ): 'applied' | 'not_found' {
    const c = this.#source(accountId, sourceId).comments.get(commentId);
    if (!c || c.state === 'deleted') return 'not_found';
    switch (action) {
      case 'hide':
        c.state = 'hidden';
        break;
      case 'unhide':
        c.state = 'visible';
        break;
      case 'delete':
        c.state = 'deleted';
        break;
      case 'ban_author':
        this.#banned.add(c.authorId);
        break;
      case 'unban_author':
        this.#banned.delete(c.authorId);
        break;
      case 'report':
        break;
    }
    return 'applied';
  }

  // ---- internals ----

  #source(accountId: string, sourceId: string): Source {
    const s = this.#sources.get(sourceId);
    if (s?.accountId !== accountId) throw new PlatformError(404, 'source_not_found');
    return s;
  }

  #issue(prefix: string): string {
    const t = token(prefix);
    this.#issued.push(t);
    return t;
  }

  #newAccess(accountId: string): { accessToken: string; expiresAt: number } {
    const accessToken = this.#issue('ref_at_');
    const expiresAt = this.opts.clock.now() + this.opts.accessTokenTtlMs;
    this.#access.set(accessToken, { accountId, expiresAt, revoked: false });
    return { accessToken, expiresAt };
  }
}
