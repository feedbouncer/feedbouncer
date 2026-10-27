import { ConnectorError, type ConnectorErrorKind } from '@feedbouncer/connectors';

type Mapped = { kind: ConnectorErrorKind; code: string };
const tokenInvalid: Mapped = { kind: 'auth_expired', code: 'token_invalid' };
const throttled: Mapped = { kind: 'rate_limited', code: 'throttled' };
const notFound: Mapped = { kind: 'not_found', code: 'media_not_found' };
const denied: Mapped = { kind: 'permanent', code: 'permission_denied' };
const unavailable: Mapped = { kind: 'transient', code: 'threads_unavailable' };

/**
 * Graph error `code` to outcome (primary assumption V9/V10). Only numbers are read from an error
 * body; Meta's `message` is never used. Entries keyed by code and subcode win over the code alone.
 */
export const THREADS_ERROR_TABLE = {
  byCode: new Map<number, Mapped>([
    [190, tokenInvalid],
    [102, tokenInvalid],
    [4, throttled],
    [17, throttled],
    [32, throttled],
    [613, throttled],
    [10, denied],
    [1, unavailable],
    [2, unavailable],
    ...Array.from({ length: 100 }, (_, i): [number, Mapped] => [200 + i, denied]),
  ]),
  bySubcode: new Map<string, Mapped>([
    ['4:2207051', { kind: 'rate_limited', code: 'reply_quota_exhausted' }],
    ['100:33', notFound],
  ]),
};

export function mapThreadsError(e: {
  httpStatus: number;
  code: number | null;
  subcode: number | null;
  retryAfterMs: number | null;
}): ConnectorError {
  const { httpStatus, code, subcode } = e;
  const known =
    code === null
      ? undefined
      : (THREADS_ERROR_TABLE.bySubcode.get(`${code}:${subcode}`) ??
        THREADS_ERROR_TABLE.byCode.get(code));
  const m: Mapped =
    known ??
    (httpStatus === 429
      ? throttled
      : httpStatus === 404
        ? notFound
        : httpStatus === 401
          ? tokenInvalid
          : httpStatus >= 500
            ? unavailable
            : code !== null && code >= 0
              ? { kind: 'permanent', code: `threads_error_${code}` }
              : { kind: 'permanent', code: `threads_http_${httpStatus}` });
  return new ConnectorError(
    m.kind,
    m.code,
    m.kind === 'rate_limited' && e.retryAfterMs !== null ? { retryAfterMs: e.retryAfterMs } : {},
  );
}
