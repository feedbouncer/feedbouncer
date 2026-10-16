import { APICallError, NoObjectGeneratedError } from 'ai';

export type ProviderErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'auth'
  | 'invalid_output'
  | 'bad_request'
  | 'disabled';

/** Closed codes only; a foreign error's message is never copied (it can echo request data). */
export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    readonly code: ProviderErrorCode,
    readonly retryable: boolean,
  ) {
    super(`provider error: ${code}`);
  }
}

export function mapProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (NoObjectGeneratedError.isInstance(e)) return new ProviderError('invalid_output', true);
  if (APICallError.isInstance(e)) {
    const s = e.statusCode;
    if (s === 401 || s === 403) return new ProviderError('auth', false);
    if (s === 429) return new ProviderError('rate_limited', true);
    if (s !== undefined && s >= 400 && s < 500 && s !== 408) {
      return new ProviderError('bad_request', false);
    }
    return new ProviderError('unavailable', true);
  }
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
    return new ProviderError('timeout', true);
  }
  return new ProviderError('unavailable', true);
}
