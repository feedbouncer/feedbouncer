import { ConnectorError, type ConnectorErrorKind } from '@feedbouncer/connectors';

type Mapped = { kind: ConnectorErrorKind; code: string };
const token_invalid: Mapped = { kind: 'auth_expired', code: 'token_invalid' };

/** Envelope `code` to error (primary assumption V10; the TikTok `message` is never read). */
export const TIKTOK_ERROR_CODES: Readonly<Record<number, Mapped>> = {
  40100: { kind: 'rate_limited', code: 'throttled' },
  40001: { kind: 'permanent', code: 'permission_denied' },
  40002: { kind: 'permanent', code: 'invalid_request' },
  40102: token_invalid,
  40104: token_invalid,
  40105: token_invalid,
  40400: { kind: 'not_found', code: 'comment_not_found' },
};

const unavailable: Mapped = { kind: 'transient', code: 'tiktok_unavailable' };

export function mapTikTokError(e: {
  httpStatus: number;
  code: number | null;
  retryAfterMs: number | null;
}): ConnectorError {
  const { httpStatus, code } = e;
  const known = code === null ? undefined : TIKTOK_ERROR_CODES[code];
  const m: Mapped =
    known ??
    (code !== null && code >= 50000 && code <= 59999
      ? unavailable
      : httpStatus === 429
        ? { kind: 'rate_limited', code: 'throttled' }
        : httpStatus >= 500
          ? unavailable
          : code !== null && Number.isInteger(code) && code > 0
            ? { kind: 'permanent', code: `tiktok_error_${code}` }
            : { kind: 'permanent', code: `tiktok_http_${httpStatus}` });
  return new ConnectorError(
    m.kind,
    m.code,
    m.kind === 'rate_limited' && e.retryAfterMs !== null ? { retryAfterMs: e.retryAfterMs } : {},
  );
}
