// The shared error taxonomy. Messages are built ONLY from the kind and a
// validated snake_case code, so a ConnectorError can never carry a token,
// URL or platform response text. Foreign errors are replaced, not wrapped.
import { ERROR_CODE, type ErrorClass } from '@feedbouncer/service-runtime';

export const CONNECTOR_ERROR_KINDS = [
  'auth_expired',
  'rate_limited',
  'not_found',
  'unsupported',
  'transient',
  'permanent',
] as const;
export type ConnectorErrorKind = (typeof CONNECTOR_ERROR_KINDS)[number];

const MAX_RETRY_AFTER_MS = 86_400_000;

export interface ConnectorErrorInfo {
  readonly kind: ConnectorErrorKind;
  readonly code: string;
  readonly retryAfterMs: number | null;
  readonly reauthorize: boolean;
}

export class ConnectorError extends Error {
  override name = 'ConnectorError';
  readonly code: string;
  readonly retryAfterMs: number | null;
  readonly reauthorize: boolean;

  constructor(
    readonly kind: ConnectorErrorKind,
    code: string,
    opts: { retryAfterMs?: number; reauthorize?: boolean } = {},
  ) {
    const safe = ERROR_CODE.test(code) ? code : 'unspecified';
    super(`${kind}: ${safe}`);
    this.code = safe;
    const r = opts.retryAfterMs;
    this.retryAfterMs =
      r === undefined || !Number.isFinite(r)
        ? null
        : Math.min(Math.max(Math.ceil(r), 0), MAX_RETRY_AFTER_MS);
    this.reauthorize = opts.reauthorize ?? false;
  }

  get retryable(): boolean {
    return this.kind === 'transient' || this.kind === 'rate_limited';
  }

  /** The job-layer failure class; `classifyFailure` in the jobs package agrees with it. */
  get errorClass(): ErrorClass {
    switch (this.kind) {
      case 'transient':
        return 'retryable';
      case 'rate_limited':
        return 'rate_limited';
      case 'auth_expired':
        return this.reauthorize ? 'needs_reconnection' : 'non_retryable';
      default:
        return 'non_retryable';
    }
  }

  info(): ConnectorErrorInfo {
    return {
      kind: this.kind,
      code: this.code,
      retryAfterMs: this.retryAfterMs,
      reauthorize: this.reauthorize,
    };
  }

  toJSON(): ConnectorErrorInfo {
    return this.info();
  }
}

export function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err;
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new ConnectorError('transient', 'timeout');
  }
  return new ConnectorError('permanent', 'connector_failure');
}
