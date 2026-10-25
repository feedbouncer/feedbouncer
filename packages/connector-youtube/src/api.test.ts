import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectorError,
  createSafeHttp,
  type CallContext,
  type QuotaMeter,
} from '@feedbouncer/connectors';
import { Secret } from '@feedbouncer/service-runtime';
import * as z from 'zod';
import { mapGoogleError, youtubeCall } from './api.js';
import { API_HOSTS } from './config.js';
import { FakeYouTube } from './testing/index.js';

const CHANNEL = 'UC' + 'c'.repeat(22);
const NOW = Date.parse('2026-10-24T10:00:00Z');
const ANY = z.unknown();

let fake: FakeYouTube;
let events: string[];
let meter: QuotaMeter & {
  reserve: ReturnType<typeof vi.fn<QuotaMeter['reserve']>>;
  settle: ReturnType<typeof vi.fn<QuotaMeter['settle']>>;
};
let token: string;

function context(fetch: typeof globalThis.fetch, quota: QuotaMeter | null = meter) {
  const recorded: typeof globalThis.fetch = (input, init) => {
    events.push('fetch');
    return fetch(input, init);
  };
  const ctx: CallContext = {
    accessToken: new Secret(token),
    externalAccountId: CHANNEL,
    http: createSafeHttp({ allowedHosts: API_HOSTS, fetch: recorded }),
    signal: AbortSignal.timeout(2000),
    reportQuota: async () => {},
    ...(quota && { quota }),
  };
  return ctx;
}

beforeEach(() => {
  events = [];
  fake = new FakeYouTube({
    clientId: 'cid',
    clientSecret: 'secret',
    channel: { id: CHANNEL, title: 'Mine' },
    clock: () => NOW,
  });
  token = fake.issueAccessToken();
  let n = 0;
  meter = {
    reserve: vi.fn<QuotaMeter['reserve']>(async (req) => {
      events.push('reserve');
      n += 1;
      return { callKey: `k${n}`, units: req.units };
    }),
    settle: vi.fn<QuotaMeter['settle']>(async () => {
      events.push('settle');
    }),
  };
});

const listThreads = (ctx: CallContext) =>
  youtubeCall(
    ctx,
    'commentThreads.list',
    { allThreadsRelatedToChannelId: CHANNEL, part: 'snippet' },
    z.object({ items: z.array(z.unknown()) }),
    { purpose: 'read' },
  );

describe('youtubeCall', () => {
  it('reserves COST before the request and settles ok', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const ctx = context(async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return fake.fetch(input, init);
    });
    await expect(listThreads(ctx)).resolves.toEqual({ items: [] });
    expect(meter.reserve).toHaveBeenCalledWith({
      method: 'commentThreads.list',
      units: 1,
      purpose: 'read',
    });
    expect(events).toEqual(['reserve', 'fetch', 'settle']);
    expect(meter.settle).toHaveBeenCalledWith({ callKey: 'k1', units: 1 }, { ok: true });
    const u = new URL(seen[0]!.url);
    expect(u.origin + u.pathname).toBe('https://www.googleapis.com/youtube/v3/commentThreads');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      allThreadsRelatedToChannelId: CHANNEL,
      part: 'snippet',
    });
    expect(seen[0]!.auth).toBe(`Bearer ${token}`);
  });

  it('charges failed calls', async () => {
    fake.failNext('backendError', 500);
    await expect(listThreads(context(fake.fetch))).rejects.toMatchObject({
      kind: 'transient',
      code: 'platform_unavailable',
    });
    expect(meter.settle).toHaveBeenCalledTimes(1);
    const [ticket, outcome] = meter.settle.mock.calls[0]!;
    expect(ticket.units).toBe(1);
    expect(outcome).toMatchObject({ ok: false });
    expect(fake.calls.map((c) => c.units)).toEqual([1]);
  });

  it('maps quotaExceeded to rate_limited quota_exceeded and flags the pause', async () => {
    fake.exhaustQuotaAt(0);
    await expect(listThreads(context(fake.fetch))).rejects.toMatchObject({
      kind: 'rate_limited',
      code: 'quota_exceeded',
    });
    expect(meter.settle.mock.calls[0]![1]).toMatchObject({
      ok: false,
      errorCode: 'quota_exceeded',
      quotaExceeded: true,
    });
  });

  it.each([
    ['commentsDisabled', 403, { kind: 'permanent', code: 'comments_disabled' }],
    ['forbidden', 403, { kind: 'permanent', code: 'forbidden' }],
    ['commentNotFound', 404, { kind: 'not_found', code: 'comment_not_found' }],
    ['authError', 401, { kind: 'auth_expired', code: 'oauth_access_rejected', reauthorize: false }],
    [
      'insufficientPermissions',
      403,
      { kind: 'auth_expired', code: 'oauth_scope_missing', missingScopes: ['youtube.force-ssl'] },
    ],
  ] as const)(
    'maps commentsDisabled, forbidden, 404 commentNotFound, 401, insufficientPermissions: %s',
    async (reason, status, expected) => {
      fake.failNext(reason, status);
      const err: unknown = await listThreads(context(fake.fetch)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      expect(err).toMatchObject(expected);
      expect(meter.settle.mock.calls[0]![1]).toMatchObject({ ok: false, errorCode: expected.code });
      expect(meter.settle.mock.calls[0]![1]).not.toHaveProperty('quotaExceeded');
    },
  );

  it('never includes the response body or token in error messages', async () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: `SECRET123 ${token}`,
        errors: [{ reason: 'SECRET123', message: 'SECRET123' }],
      },
    });
    for (const status of [400, 403, 404, 500]) {
      const err: unknown = await listThreads(
        context(async () => new Response(body, { status })),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectorError);
      for (const s of [String(err), JSON.stringify(err), (err as Error).stack ?? '']) {
        expect(s).not.toContain('SECRET123');
        expect(s).not.toContain(token);
      }
    }
  });

  it('throws quota_meter_required without ctx.quota', async () => {
    await expect(listThreads(context(fake.fetch, null))).rejects.toMatchObject({
      kind: 'permanent',
      code: 'quota_meter_required',
    });
    expect(events).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('a meter refusal makes no request and settles nothing', async () => {
    meter.reserve.mockRejectedValueOnce(
      new ConnectorError('rate_limited', 'quota_budget_exhausted', { retryAfterMs: 1000 }),
    );
    await expect(listThreads(context(fake.fetch))).rejects.toMatchObject({
      code: 'quota_budget_exhausted',
    });
    expect(events).toEqual([]);
    expect(meter.settle).not.toHaveBeenCalled();
  });

  it('setModerationStatus is a 50-unit write POST that returns null on 204', async () => {
    const v = fake.addVideo();
    const c = fake.addComment({ videoId: v, text: 'x' });
    const out = await youtubeCall(
      context(fake.fetch),
      'comments.setModerationStatus',
      { id: c, moderationStatus: 'rejected' },
      ANY,
    );
    expect(out).toBeNull();
    expect(meter.reserve).toHaveBeenCalledWith({
      method: 'comments.setModerationStatus',
      units: 50,
      purpose: 'write',
    });
    expect(fake.calls).toEqual([
      {
        method: 'comments.setModerationStatus',
        query: { id: c, moderationStatus: 'rejected' },
        units: 50,
      },
    ]);
    expect(fake.comment(c)!.status).toBe('rejected');
    expect(meter.settle).toHaveBeenCalledWith({ callKey: 'k1', units: 50 }, { ok: true });
  });

  it('a body that fails the schema is invalid_platform_response and still settled', async () => {
    const ctx = context(async () => Response.json({ items: 'nope' }));
    await expect(listThreads(ctx)).rejects.toMatchObject({
      kind: 'permanent',
      code: 'invalid_platform_response',
    });
    const ctx2 = context(async () => new Response('<html>', { status: 200 }));
    await expect(listThreads(ctx2)).rejects.toMatchObject({ code: 'invalid_platform_response' });
    expect(meter.settle.mock.calls.map((c) => c[1])).toEqual([
      { ok: false, errorCode: 'invalid_platform_response' },
      { ok: false, errorCode: 'invalid_platform_response' },
    ]);
  });

  it('a network failure is transient and settled as failed', async () => {
    const ctx = context(async () => {
      throw new TypeError('socket hang up');
    });
    await expect(listThreads(ctx)).rejects.toMatchObject({ kind: 'transient' });
    expect(meter.settle.mock.calls[0]![1]).toMatchObject({ ok: false });
  });

  it('a settle failure does not mask the call outcome', async () => {
    meter.settle.mockRejectedValue(new Error('db down'));
    await expect(listThreads(context(fake.fetch))).resolves.toEqual({ items: [] });
    fake.failNext('forbidden', 403);
    await expect(listThreads(context(fake.fetch))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses an unknown method before reserving', async () => {
    await expect(
      youtubeCall(context(fake.fetch), 'videos.delete' as never, {}, ANY),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'invalid_request' });
    expect(meter.reserve).not.toHaveBeenCalled();
  });
});

describe('mapGoogleError', () => {
  const body = (reason: string) => JSON.stringify({ error: { errors: [{ reason }] } });

  it('maps throttles with Retry-After', () => {
    const e = mapGoogleError(403, body('rateLimitExceeded'), { retryAfter: '30' });
    expect(e).toMatchObject({ kind: 'rate_limited', code: 'rate_limited', retryAfterMs: 30_000 });
    expect(mapGoogleError(403, body('userRateLimitExceeded'))).toMatchObject({
      kind: 'rate_limited',
      code: 'rate_limited',
    });
    expect(mapGoogleError(429, '')).toMatchObject({ kind: 'rate_limited', code: 'rate_limited' });
  });

  it('maps dailyLimitExceeded like quotaExceeded', () => {
    expect(mapGoogleError(403, body('dailyLimitExceeded'))).toMatchObject({
      kind: 'rate_limited',
      code: 'quota_exceeded',
    });
  });

  it('maps 404 reasons to snake case, other 400s to bad_request and 5xx to unavailable', () => {
    expect(mapGoogleError(404, body('videoNotFound'))).toMatchObject({
      kind: 'not_found',
      code: 'video_not_found',
    });
    expect(mapGoogleError(404, 'not json')).toMatchObject({ kind: 'not_found', code: 'not_found' });
    expect(mapGoogleError(404, body('../x'))).toMatchObject({ code: 'not_found' });
    expect(mapGoogleError(400, body('operationNotSupported'))).toMatchObject({
      kind: 'permanent',
      code: 'bad_request',
    });
    expect(mapGoogleError(503, body('backendError'))).toMatchObject({
      kind: 'transient',
      code: 'platform_unavailable',
    });
  });

  it('exposes the validated reason for callers that branch on it', () => {
    expect(mapGoogleError(400, body('operationNotSupported')).reason).toBe('operationNotSupported');
    expect(mapGoogleError(400, body('bad reason!')).reason).toBeNull();
  });
});
