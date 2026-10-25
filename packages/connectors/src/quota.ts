// A metered daily quota (YouTube Data API units) that a connector reserves
// before each platform call and settles after it. Unlike RateBudget, a refusal
// here is local bookkeeping, not a platform throttle.
import { ConnectorError } from './errors.js';

export type QuotaPurpose = 'read' | 'write' | 'connect';

export interface QuotaTicket {
  readonly callKey: string;
  readonly units: number;
}

export interface QuotaMeter {
  /** Throws ConnectorError('rate_limited', 'quota_budget_exhausted' | 'quota_paused', {retryAfterMs}) when the call does not fit. */
  reserve(req: { method: string; units: number; purpose: QuotaPurpose }): Promise<QuotaTicket>;
  /** Idempotent per callKey. `quotaExceeded: true` records the project-wide pause. */
  settle(
    t: QuotaTicket,
    o: { ok: boolean; errorCode?: string; quotaExceeded?: boolean },
  ): Promise<void>;
}

export const QUOTA_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'quota_budget_exhausted',
  'quota_paused',
]);

/** A `QuotaMeter.reserve` refusal: no platform call was made. */
export const isQuotaRefusal = (err: unknown): boolean =>
  err instanceof ConnectorError && err.kind === 'rate_limited' && QUOTA_REFUSAL_CODES.has(err.code);
