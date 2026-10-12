// The shared error taxonomy. Messages are built ONLY from the kind and a
// validated snake_case code, so a ConnectorError can never carry a token,
// URL or platform response text. Foreign errors are replaced, not wrapped.
export const CONNECTOR_ERROR_KINDS = [
  'auth_expired',
  'rate_limited',
  'not_found',
  'unsupported',
  'transient',
  'permanent',
] as const;
export type ConnectorErrorKind = (typeof CONNECTOR_ERROR_KINDS)[number];

const CODE = /^[a-z][a-z0-9_]{0,62}$/;
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
    const safe = CODE.test(code) ? code : 'unspecified';
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
