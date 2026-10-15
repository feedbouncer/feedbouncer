import { describe, expect, it } from 'vitest';
import { CONNECTOR_ERROR_KINDS, ConnectorError } from '@feedbouncer/connectors';
import { DEFAULT_RETRY_POLICY } from './policy.js';
import { JobDeferral, JobError, classifyFailure, decide, requireActionSuccess } from './failure.js';

const P = {
  ...DEFAULT_RETRY_POLICY,
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  maxDeferrals: 3,
  maxDeferredMs: 60_000,
};
const S = { failures: 0, deferrals: 0, deferredMs: 0, replays: 0 };
const half = () => 0;

describe('classifyFailure', () => {
  it.each([
    [new ConnectorError('transient', 'upstream_5xx'), { kind: 'retryable', code: 'upstream_5xx' }],
    [
      new ConnectorError('rate_limited', 'throttled', { retryAfterMs: 1200 }),
      { kind: 'rate_limited', code: 'throttled', retryAfterMs: 1200 },
    ],
    [
      new ConnectorError('auth_expired', 'reauthorization_required', { reauthorize: true }),
      { kind: 'needs_reconnection', code: 'reauthorization_required' },
    ],
    [
      new ConnectorError('auth_expired', 'connection_revoked'),
      { kind: 'non_retryable', code: 'connection_revoked', targetGone: false },
    ],
    [
      new ConnectorError('not_found', 'comment_missing'),
      { kind: 'non_retryable', code: 'target_not_found', targetGone: true },
    ],
    [
      new ConnectorError('not_found', 'connection_not_found'),
      { kind: 'non_retryable', code: 'connection_not_found', targetGone: false },
    ],
    [
      new ConnectorError('permanent', 'invalid_request'),
      { kind: 'non_retryable', code: 'invalid_request', targetGone: false },
    ],
    [
      new ConnectorError('unsupported', 'list_sources'),
      { kind: 'non_retryable', code: 'list_sources', targetGone: false },
    ],
    [
      new JobError('non_retryable', 'target_not_found'),
      { kind: 'non_retryable', code: 'target_not_found', targetGone: true },
    ],
    [new JobError('retryable', 'lock_busy'), { kind: 'retryable', code: 'lock_busy' }],
    [
      Object.assign(new Error('x'), { name: 'TimeoutError' }),
      { kind: 'retryable', code: 'timeout' },
    ],
    [
      new Error('https://graph.example/?access_token=SECRET'),
      { kind: 'retryable', code: 'unexpected_error' },
    ],
    ['a string', { kind: 'retryable', code: 'unexpected_error' }],
  ])('%s', (err, expected) => {
    expect(classifyFailure(err)).toEqual(expected);
  });

  it('never carries a foreign message', () => {
    expect(JSON.stringify(classifyFailure(new Error('token=abc')))).not.toContain('abc');
  });
});

describe('decide', () => {
  it('retries with backoff until the attempt cap, then dead-letters', () => {
    const f = { kind: 'retryable', code: 'upstream_5xx' } as const;
    expect(decide(f, S, P, half)).toEqual({ type: 'retry', delayMs: 500 });
    expect(decide(f, { ...S, failures: 1 }, P, half)).toEqual({ type: 'retry', delayMs: 1_000 });
    expect(decide(f, { ...S, failures: 2 }, P, half)).toEqual({
      type: 'dead_letter',
      reason: 'retries_exhausted',
      countsAsFailure: true,
      resolution: null,
    });
  });

  it('defers rate limits by at least the platform hint without counting a failure', () => {
    const d = decide(
      { kind: 'rate_limited', code: 'throttled', retryAfterMs: 20_000 },
      { ...S, failures: 2 },
      P,
      () => 0.99,
    );
    expect(d.type).toBe('defer');
    if (d.type !== 'defer') throw new Error('expected defer');
    expect(d.delayMs).toBeGreaterThanOrEqual(20_000);
    expect(d.delayMs).toBeLessThanOrEqual(22_000);
  });

  it('lets the platform hint exceed maxDelayMs', () => {
    const d = decide({ kind: 'rate_limited', code: 'throttled', retryAfterMs: 30_000 }, S, P, half);
    expect(d).toEqual({ type: 'defer', delayMs: 30_000 });
  });

  it('floors a zero or absent hint at baseDelayMs (no hot loop)', () => {
    for (const retryAfterMs of [0, null]) {
      const d = decide({ kind: 'rate_limited', code: 'throttled', retryAfterMs }, S, P, half);
      expect(d.type === 'defer' && d.delayMs >= P.baseDelayMs).toBe(true);
    }
  });

  it('dead-letters when the deferral count or time budget would be exceeded', () => {
    const f = { kind: 'rate_limited', code: 'throttled', retryAfterMs: 5_000 } as const;
    expect(decide(f, { ...S, deferrals: 3 }, P, half)).toMatchObject({
      type: 'dead_letter',
      reason: 'rate_limit_exhausted',
    });
    expect(decide({ ...f, retryAfterMs: 86_400_000 }, S, P, half)).toMatchObject({
      type: 'dead_letter',
      reason: 'rate_limit_exhausted',
      countsAsFailure: false,
    });
  });

  it('sends non-retryable and reconnection failures straight to the DLQ', () => {
    expect(
      decide({ kind: 'non_retryable', code: 'invalid_request', targetGone: false }, S, P, half),
    ).toEqual({
      type: 'dead_letter',
      reason: 'non_retryable',
      countsAsFailure: true,
      resolution: null,
    });
    expect(
      decide({ kind: 'needs_reconnection', code: 'reauthorization_required' }, S, P, half),
    ).toEqual({
      type: 'dead_letter',
      reason: 'needs_reconnection',
      countsAsFailure: true,
      resolution: null,
    });
  });

  it('resolves (does not re-open) a replayed job whose target is gone', () => {
    const f = { kind: 'non_retryable', code: 'target_not_found', targetGone: true } as const;
    expect(decide(f, S, P, half)).toMatchObject({ reason: 'non_retryable', resolution: null });
    expect(decide(f, { ...S, replays: 1 }, P, half)).toMatchObject({
      reason: 'non_retryable',
      resolution: 'target_gone',
    });
  });
});

describe('requireActionSuccess', () => {
  const req = { action: 'hide', target: { sourceExternalId: 's', externalId: 'c' } } as const;
  it('records applied actions with their undo for reversibility', () => {
    expect(
      requireActionSuccess({
        status: 'applied',
        request: req,
        platformActionId: 'p1',
        undo: { action: 'unhide', target: req.target },
      }),
    ).toEqual({ status: 'applied', action: 'hide', platformActionId: 'p1', undoAction: 'unhide' });
  });
  it('treats delete+not_found as success-equivalent', () => {
    expect(
      requireActionSuccess({ status: 'not_found', request: { ...req, action: 'delete' } }),
    ).toEqual({
      status: 'already_absent',
      action: 'delete',
      platformActionId: null,
      undoAction: null,
    });
  });
  it('throws classified errors otherwise', () => {
    expect(() => requireActionSuccess({ status: 'not_found', request: req })).toThrow(JobError);
    expect(() => requireActionSuccess({ status: 'unsupported', request: req })).toThrow(
      'non_retryable: action_unsupported',
    );
    expect(() =>
      requireActionSuccess({
        status: 'failed',
        request: req,
        error: { kind: 'rate_limited', code: 'throttled', retryAfterMs: 900, reauthorize: false },
      }),
    ).toThrow(expect.objectContaining({ kind: 'rate_limited', retryAfterMs: 900 }));
  });
});

describe('classifyFailure and ConnectorError.errorClass', () => {
  it('agree for every kind', () => {
    for (const kind of CONNECTOR_ERROR_KINDS)
      for (const reauthorize of [true, false]) {
        const err = new ConnectorError(kind, 'some_code', { reauthorize });
        expect(classifyFailure(err).kind).toBe(err.errorClass);
      }
  });
});

describe('JobDeferral', () => {
  it('classifies as rate_limited so it defers without counting as a failure', () => {
    const f = classifyFailure(new JobDeferral('classifier_brand_busy', null));
    expect(f).toEqual({ kind: 'rate_limited', code: 'classifier_brand_busy', retryAfterMs: null });
    expect(decide(f, S, P, half).type).toBe('defer');
  });
  it('sanitises non-snake_case codes', () => {
    expect(new JobDeferral('Bad Code', 1000).code).toBe('unspecified');
  });
});
