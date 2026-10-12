// Turns whatever a handler threw into one of four classes, then into a
// disposition. Codes are snake_case only; a foreign error's message is never
// read (it can embed a token-bearing URL), only its name for timeouts.
import { ConnectorError, isSuccessEquivalent, type ActionResult } from '@feedbouncer/connectors';
import { SNAKE_CASE } from './keys.js';
import { backoffDelayMs, unit, type RetryPolicy } from './policy.js';

export type JobResult = Readonly<Record<string, string | number | boolean | null>>;

export class JobError extends Error {
  override name = 'JobError';
  readonly code: string;
  constructor(
    readonly kind: 'retryable' | 'non_retryable',
    code: string,
  ) {
    const safe = SNAKE_CASE.test(code) ? code : 'unspecified';
    super(`${kind}: ${safe}`);
    this.code = safe;
  }
}

export type FailureClass =
  | { readonly kind: 'retryable'; readonly code: string }
  | { readonly kind: 'rate_limited'; readonly code: string; readonly retryAfterMs: number | null }
  | { readonly kind: 'non_retryable'; readonly code: string; readonly targetGone: boolean }
  | { readonly kind: 'needs_reconnection'; readonly code: string };

export const DEAD_LETTER_REASONS = [
  'retries_exhausted',
  'non_retryable',
  'needs_reconnection',
  'rate_limit_exhausted',
  'stall_limit_exceeded',
  'invalid_job',
] as const;
export type DeadLetterReason = (typeof DEAD_LETTER_REASONS)[number];

export type Disposition =
  | { readonly type: 'retry'; readonly delayMs: number }
  | { readonly type: 'defer'; readonly delayMs: number }
  | {
      readonly type: 'dead_letter';
      readonly reason: DeadLetterReason;
      /** false for rate-limit exhaustion: no failure happened. */
      readonly countsAsFailure: boolean;
      /** Non-null moves the row to `resolved` instead of `dead_lettered`. */
      readonly resolution: string | null;
    };

export interface FailureState {
  readonly failures: number;
  readonly deferrals: number;
  readonly deferredMs: number;
  readonly replays: number;
}

const nonRetryable = (code: string, targetGone = false): FailureClass => ({
  kind: 'non_retryable',
  code,
  targetGone,
});

export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof JobError) {
    return err.kind === 'retryable'
      ? { kind: 'retryable', code: err.code }
      : nonRetryable(err.code, err.code === 'target_not_found');
  }
  if (err instanceof ConnectorError) {
    switch (err.kind) {
      case 'transient':
        return { kind: 'retryable', code: err.code };
      case 'rate_limited':
        return { kind: 'rate_limited', code: err.code, retryAfterMs: err.retryAfterMs };
      case 'auth_expired':
        return err.reauthorize
          ? { kind: 'needs_reconnection', code: err.code }
          : nonRetryable(err.code);
      case 'not_found':
        return err.code === 'connection_not_found'
          ? nonRetryable(err.code)
          : nonRetryable('target_not_found', true);
      default:
        return nonRetryable(err.code);
    }
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return { kind: 'retryable', code: 'timeout' };
  }
  return { kind: 'retryable', code: 'unexpected_error' };
}

const deadLetter = (
  reason: DeadLetterReason,
  countsAsFailure = true,
  resolution: string | null = null,
): Disposition => ({ type: 'dead_letter', reason, countsAsFailure, resolution });

export function decide(
  f: FailureClass,
  s: FailureState,
  p: RetryPolicy,
  random: () => number,
): Disposition {
  switch (f.kind) {
    case 'retryable': {
      const n = s.failures + 1;
      return n >= p.maxAttempts
        ? deadLetter('retries_exhausted')
        : { type: 'retry', delayMs: backoffDelayMs(n, p, random) };
    }
    case 'rate_limited': {
      // The platform hint wins over maxDelayMs; only the deferral budget bounds it.
      const hint = Math.max(
        f.retryAfterMs ?? backoffDelayMs(s.deferrals + 1, p, random),
        p.baseDelayMs,
      );
      const delayMs = hint + Math.floor(unit(random()) * Math.min(hint * 0.1, 30_000));
      if (s.deferrals + 1 > p.maxDeferrals || s.deferredMs + delayMs > p.maxDeferredMs) {
        return deadLetter('rate_limit_exhausted', false);
      }
      return { type: 'defer', delayMs };
    }
    case 'needs_reconnection':
      return deadLetter('needs_reconnection');
    case 'non_retryable':
      return deadLetter(
        'non_retryable',
        true,
        f.targetGone && s.replays > 0 ? 'target_gone' : null,
      );
  }
}

/** For action handlers: turns a ConnectionClient.act() result into a JobResult or a classified throw. */
export function requireActionSuccess(r: ActionResult): JobResult {
  if (r.status === 'applied') {
    return {
      status: 'applied',
      action: r.request.action,
      platformActionId: r.platformActionId,
      undoAction: r.undo?.action ?? null,
    };
  }
  if (isSuccessEquivalent(r)) {
    return {
      status: 'already_absent',
      action: r.request.action,
      platformActionId: null,
      undoAction: null,
    };
  }
  if (r.status === 'not_found') throw new JobError('non_retryable', 'target_not_found');
  if (r.status === 'unsupported') throw new JobError('non_retryable', 'action_unsupported');
  throw new ConnectorError(r.error.kind, r.error.code, {
    ...(r.error.retryAfterMs !== null ? { retryAfterMs: r.error.retryAfterMs } : {}),
    reauthorize: r.error.reauthorize,
  });
}
