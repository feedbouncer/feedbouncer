// The one way this package calls the Data API: reserve the unit cost on the
// quota meter, send, settle. Errors carry a kind and a code only; the response
// body, the URL and the token never reach an error.
import {
  ConnectorError,
  parseRetryAfter,
  toConnectorError,
  type CallContext,
  type ConnectorErrorKind,
  type QuotaPurpose,
} from '@feedbouncer/connectors';
import * as z from 'zod';
import { YOUTUBE_SCOPE_SHORT } from './config.js';
import { COST, type YouTubeMethod } from './costs.js';

const API_BASE = 'https://www.googleapis.com';

const ENDPOINTS: Readonly<
  Record<YouTubeMethod, { path: string; method: 'GET' | 'POST'; purpose: QuotaPurpose }>
> = {
  'commentThreads.list': { path: 'commentThreads', method: 'GET', purpose: 'read' },
  'comments.list': { path: 'comments', method: 'GET', purpose: 'read' },
  'channels.list': { path: 'channels', method: 'GET', purpose: 'read' },
  'comments.setModerationStatus': {
    path: 'comments/setModerationStatus',
    method: 'POST',
    purpose: 'write',
  },
};

/** A Google API failure. `reason` is the validated `error.errors[0].reason`, never free text. */
export class YouTubeApiError extends ConnectorError {
  constructor(
    kind: ConnectorErrorKind,
    code: string,
    readonly status: number,
    readonly reason: string | null,
    opts: { retryAfterMs?: number; reauthorize?: boolean; missingScopes?: readonly string[] } = {},
  ) {
    super(kind, code, opts);
  }
}

const REASON = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const ERROR_BODY = z.object({
  error: z.object({ errors: z.array(z.object({ reason: z.string() })).min(1) }),
});

function reasonOf(body: unknown): string | null {
  let json: unknown = body;
  if (typeof body === 'string') {
    try {
      json = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const parsed = ERROR_BODY.safeParse(json);
  const r = parsed.success ? parsed.data.error.errors[0]!.reason : null;
  return r !== null && REASON.test(r) ? r : null;
}

const snake = (r: string) => r.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, '');

const QUOTA = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const THROTTLE = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/** Maps a Google error response (raw body or parsed JSON) to a ConnectorError. */
export function mapGoogleError(
  status: number,
  body: unknown,
  opts: { retryAfter?: string | null; nowMs?: number } = {},
): YouTubeApiError {
  const reason = reasonOf(body);
  const err = (
    kind: ConnectorErrorKind,
    code: string,
    o: ConstructorParameters<typeof YouTubeApiError>[4] = {},
  ) => new YouTubeApiError(kind, code, status, reason, o);

  if (reason !== null && QUOTA.has(reason)) return err('rate_limited', 'quota_exceeded');
  if ((reason !== null && THROTTLE.has(reason)) || status === 429) {
    const retryAfterMs = parseRetryAfter(opts.retryAfter ?? null, opts.nowMs ?? Date.now());
    return err('rate_limited', 'rate_limited', retryAfterMs === null ? {} : { retryAfterMs });
  }
  if (status === 401) return err('auth_expired', 'oauth_access_rejected', { reauthorize: false });
  if (reason === 'insufficientPermissions') {
    return err('auth_expired', 'oauth_scope_missing', { missingScopes: [YOUTUBE_SCOPE_SHORT] });
  }
  if (reason === 'commentsDisabled') return err('permanent', 'comments_disabled');
  if (status === 404) return err('not_found', reason === null ? 'not_found' : snake(reason));
  if (status >= 500) return err('transient', 'platform_unavailable');
  if (reason === 'forbidden' || status === 403) return err('permanent', 'forbidden');
  return err('permanent', 'bad_request');
}

/**
 * One metered Data API call. Throws `quota_meter_required` when the context has no meter:
 * YouTube calls are never unmetered. A 204 resolves to null.
 */
export async function youtubeCall<T>(
  ctx: CallContext,
  m: YouTubeMethod,
  q: Readonly<Record<string, string>>,
  schema: z.ZodType<T>,
  opts?: { purpose: QuotaPurpose },
): Promise<T | null> {
  if (!Object.hasOwn(ENDPOINTS, m)) throw new ConnectorError('permanent', 'invalid_request');
  const ep = ENDPOINTS[m];
  const quota = ctx.quota;
  if (!quota) throw new ConnectorError('permanent', 'quota_meter_required');

  const ticket = await quota.reserve({
    method: m,
    units: COST[m],
    purpose: opts?.purpose ?? ep.purpose,
  });
  let outcome: { ok: boolean; errorCode?: string; quotaExceeded?: boolean } = {
    ok: false,
    errorCode: 'connector_failure',
  };
  try {
    const url = new URL(`/youtube/v3/${ep.path}`, API_BASE);
    url.search = new URLSearchParams(q).toString();
    const res = await ctx.http.request(
      {
        method: ep.method,
        url,
        headers: {
          authorization: `Bearer ${ctx.accessToken.reveal()}`,
          accept: 'application/json',
        },
      },
      ctx.signal,
    );
    if (res.status >= 300) {
      throw mapGoogleError(res.status, res.body, { retryAfter: res.headers.get('retry-after') });
    }
    if (res.status === 204) {
      outcome = { ok: true };
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new ConnectorError('permanent', 'invalid_platform_response');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ConnectorError('permanent', 'invalid_platform_response');
    outcome = { ok: true };
    return parsed.data;
  } catch (err) {
    const ce = toConnectorError(err);
    outcome = {
      ok: false,
      errorCode: ce.code,
      ...(ce.code === 'quota_exceeded' && { quotaExceeded: true }),
    };
    throw ce;
  } finally {
    // A failed settle leaves the reservation counted as spent (the ledger never
    // under-counts), so it must not turn a sent call into a failure that a
    // caller would retry and pay for twice.
    await quota.settle(ticket, outcome).catch(() => undefined);
  }
}
