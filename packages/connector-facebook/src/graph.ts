// The only place that talks HTTP to Graph. Tokens go in the Authorization
// header (never in URLs); the app secret never leaves this process (only its
// HMAC proof does). Errors are mapped to the framework taxonomy from numeric
// codes only: Graph error messages can contain tokens and are never read.
import { createHmac } from 'node:crypto';
import { ConnectorError, parseRetryAfter, type SafeHttp } from '@feedbouncer/connectors';
import type { Secret } from '@feedbouncer/service-runtime';

export const GRAPH_HOST = 'graph.facebook.com';
/** Up to three numeric segments: `<id>`, `<page>_<post>`, `<page>_<post>_<n>` (comment ids). */
export const GRAPH_ID = /^\d{1,32}(_\d{1,32}){0,2}$/;
const SEGMENT =
  /^(?:\d{1,32}(?:_\d{1,32}){0,2}|act_\d{1,32}|me|accounts|permissions|comments|replies|blocked|subscribed_apps|messages|oauth|access_token|adaccounts|ads|feed|media)$/;
/** Ad account id without the `act_` prefix. */
export const AD_ACCOUNT_ID = /^\d{1,32}$/;

/** Path-traversal guard for every id that came from Graph or a webhook. */
export function graphId(v: unknown): string {
  if (typeof v !== 'string' || !GRAPH_ID.test(v)) {
    throw new ConnectorError('permanent', 'invalid_graph_id');
  }
  return v;
}

/** 'act_123' or '123' → 'act_123'. Anything else throws before any I/O. */
export function adAccountNode(v: unknown): string {
  if (typeof v !== 'string') throw new ConnectorError('permanent', 'invalid_graph_id');
  const digits = v.startsWith('act_') ? v.slice(4) : v;
  if (!AD_ACCOUNT_ID.test(digits)) throw new ConnectorError('permanent', 'invalid_graph_id');
  return `act_${digits}`;
}

export interface BucUsage {
  readonly throttledForMs: number | null;
}
export interface GraphCall {
  readonly http: SafeHttp;
  readonly signal: AbortSignal;
  readonly version: string;
  readonly appSecret: Secret;
  readonly token: Secret | null;
  readonly nowMs: () => number;
}
export interface GraphRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: readonly string[];
  readonly query?: Readonly<Record<string, string>>;
  readonly form?: Readonly<Record<string, string>>;
  readonly json?: unknown;
}
export interface AdAccountUsage {
  readonly utilPct: number;
  readonly resetMs: number;
}
export interface GraphResponse {
  readonly body: unknown;
  readonly usage: BucUsage;
  readonly adAccountUsage: AdAccountUsage | null;
}

export const appSecretProof = (token: Secret, appSecret: Secret): string =>
  createHmac('sha256', appSecret.reveal()).update(token.reveal()).digest('hex');

export function parseBucUsage(header: string | null): BucUsage {
  if (!header) return { throttledForMs: null };
  try {
    const parsed: unknown = JSON.parse(header);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { throttledForMs: null };
    }
    let minutes = 0;
    for (const entries of Object.values(parsed)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries as unknown[]) {
        const m = (e as { estimated_time_to_regain_access?: unknown } | null)
          ?.estimated_time_to_regain_access;
        if (typeof m === 'number' && Number.isFinite(m) && m > minutes) minutes = m;
      }
    }
    return { throttledForMs: minutes > 0 ? Math.min(minutes, 1440) * 60_000 : null };
  } catch {
    return { throttledForMs: null };
  }
}

/** Parses `X-Ad-Account-Usage`; null when absent or malformed. */
export function parseAdAccountUsage(header: string | null): AdAccountUsage | null {
  if (!header) return null;
  try {
    const p = JSON.parse(header) as {
      acc_id_util_pct?: unknown;
      reset_time_duration?: unknown;
    } | null;
    const pct = p?.acc_id_util_pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
    const secs = p?.reset_time_duration;
    const clamped =
      typeof secs === 'number' && Number.isFinite(secs) ? Math.min(Math.max(secs, 0), 86_400) : 0;
    return { utilPct: pct, resetMs: clamped * 1000 };
  } catch {
    return null;
  }
}

const THROTTLE = new Set([4, 17, 32, 613, 80001, 80004]);
const AUTH_SUBCODES: Readonly<Record<number, string>> = {
  458: 'app_not_installed',
  459: 'user_checkpointed',
  460: 'password_changed',
  463: 'token_expired',
  464: 'user_unconfirmed',
  467: 'token_invalid',
  492: 'page_role_lost',
};

export function mapGraphError(
  e: { code?: unknown; error_subcode?: unknown; is_transient?: unknown } | null,
  httpStatus: number,
  usage: BucUsage,
  retryAfter: string | null,
  nowMs: number,
): ConnectorError {
  const code = typeof e?.code === 'number' ? e.code : null;
  const sub = typeof e?.error_subcode === 'number' ? e.error_subcode : null;
  const retryAfterMs = usage.throttledForMs ?? parseRetryAfter(retryAfter, nowMs) ?? undefined;
  if (code === 190) {
    return new ConnectorError(
      'auth_expired',
      (sub !== null && AUTH_SUBCODES[sub]) || 'token_invalid',
    );
  }
  if (code === 102) return new ConnectorError('auth_expired', 'session_invalid');
  if ((code !== null && THROTTLE.has(code)) || httpStatus === 429) {
    return new ConnectorError(
      'rate_limited',
      'platform_throttled',
      retryAfterMs === undefined ? {} : { retryAfterMs },
    );
  }
  if (code === 100 && sub === 33) return new ConnectorError('not_found', 'object_missing');
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return new ConnectorError('permanent', 'permission_denied');
  }
  if (code === 368) return new ConnectorError('permanent', 'blocked_for_policy');
  if (code === 1 || code === 2 || e?.is_transient === true || httpStatus >= 500) {
    return new ConnectorError('transient', 'platform_unavailable');
  }
  return new ConnectorError('permanent', 'graph_error');
}

// Numeric Graph codes travel beside the mapped error (never on it) so callers with
// endpoint-specific tables (ban, private reply) can refine the outcome. Numbers are
// safe to keep; the Graph message never is.
const CODES = new WeakMap<ConnectorError, { code: number | null; subcode: number | null }>();
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The raw numeric `code`/`error_subcode` behind an error thrown by `graphRequest`, if any. */
export const graphErrorCodes = (
  e: ConnectorError,
): { code: number | null; subcode: number | null } | null => CODES.get(e) ?? null;

export async function graphRequest(call: GraphCall, req: GraphRequest): Promise<GraphResponse> {
  for (const s of req.path) {
    if (!SEGMENT.test(s)) throw new ConnectorError('permanent', 'invalid_graph_id');
  }
  const url = new URL(`https://${GRAPH_HOST}/${call.version}/${req.path.join('/')}`);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (call.token) {
    headers.authorization = `Bearer ${call.token.reveal()}`;
    url.searchParams.set('appsecret_proof', appSecretProof(call.token, call.appSecret));
  }
  let body: string | undefined;
  if (req.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(req.form as Record<string, string>).toString();
  } else if (req.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(req.json);
  }
  const res = await call.http.request(
    { method: req.method, url, headers, ...(body !== undefined ? { body } : {}) },
    call.signal,
  );
  const usage = parseBucUsage(res.headers.get('x-business-use-case-usage'));
  const adAccountUsage = parseAdAccountUsage(res.headers.get('x-ad-account-usage'));
  let parsed: unknown = null;
  try {
    parsed = res.body.length > 0 ? JSON.parse(res.body) : null;
  } catch {
    parsed = null;
  }
  const err = (parsed as { error?: unknown } | null)?.error;
  const errObj = typeof err === 'object' && err !== null ? err : null;
  if (res.status >= 400 || errObj !== null) {
    const e = errObj as { code?: unknown; error_subcode?: unknown; is_transient?: unknown } | null;
    const mapped = mapGraphError(
      e,
      res.status,
      usage,
      res.headers.get('retry-after'),
      call.nowMs(),
    );
    CODES.set(mapped, { code: num(e?.code), subcode: num(e?.error_subcode) });
    throw mapped;
  }
  if (parsed === null) throw new ConnectorError('transient', 'platform_unavailable');
  return { body: parsed, usage, adAccountUsage };
}
