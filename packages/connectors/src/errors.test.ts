import { describe, expect, it } from 'vitest';
import { ConnectorError, toConnectorError } from './errors.js';

describe('ConnectorError', () => {
  it('builds its message only from kind and a validated code', () => {
    const e = new ConnectorError('permanent', 'Bearer EAAGsecret leaked');
    expect(e.code).toBe('unspecified');
    expect(e.message).toBe('permanent: unspecified');
  });

  it('serializes to safe info', () => {
    const e = new ConnectorError('rate_limited', 'platform_throttled', { retryAfterMs: 1500.2 });
    expect(JSON.parse(JSON.stringify(e))).toEqual({
      kind: 'rate_limited',
      code: 'platform_throttled',
      retryAfterMs: 1501,
      reauthorize: false,
    });
    expect(e.retryable).toBe(true);
  });

  it('clamps retryAfterMs to [0, 24h] and drops non-finite values', () => {
    expect(new ConnectorError('rate_limited', 'x', { retryAfterMs: -5 }).retryAfterMs).toBe(0);
    expect(new ConnectorError('rate_limited', 'x', { retryAfterMs: 1e12 }).retryAfterMs).toBe(
      86_400_000,
    );
    expect(
      new ConnectorError('rate_limited', 'x', { retryAfterMs: Number.NaN }).retryAfterMs,
    ).toBeNull();
  });

  it('only transient and rate_limited are retryable', () => {
    const kinds = ['auth_expired', 'not_found', 'unsupported', 'permanent'] as const;
    for (const k of kinds) expect(new ConnectorError(k, 'x').retryable).toBe(false);
    expect(new ConnectorError('transient', 'x').retryable).toBe(true);
  });
});

describe('toConnectorError', () => {
  it('passes ConnectorError through', () => {
    const e = new ConnectorError('not_found', 'comment_gone');
    expect(toConnectorError(e)).toBe(e);
  });

  it('maps aborts and timeouts to transient/timeout', () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
    expect(toConnectorError(abort).info()).toMatchObject({ kind: 'transient', code: 'timeout' });
    expect(toConnectorError(timeout).info()).toMatchObject({ kind: 'transient', code: 'timeout' });
  });

  it('never carries a foreign message', () => {
    const e = toConnectorError(
      new Error('GET https://graph.example/?access_token=SENTINEL failed'),
    );
    expect(e.info()).toEqual({
      kind: 'permanent',
      code: 'connector_failure',
      retryAfterMs: null,
      reauthorize: false,
    });
    expect(e.message).not.toContain('SENTINEL');
    expect(e.cause).toBeUndefined();
  });
});

describe('ConnectorError.errorClass', () => {
  it.each([
    ['transient', false, 'retryable'],
    ['rate_limited', false, 'rate_limited'],
    ['auth_expired', true, 'needs_reconnection'],
    ['auth_expired', false, 'non_retryable'],
    ['not_found', false, 'non_retryable'],
    ['unsupported', false, 'non_retryable'],
    ['permanent', false, 'non_retryable'],
  ] as const)('%s (reauthorize=%s) is %s', (kind, reauthorize, cls) => {
    expect(new ConnectorError(kind, 'x_code', { reauthorize }).errorClass).toBe(cls);
  });
});

describe('ConnectorError.missingScopes', () => {
  it('keeps well-formed scope names, drops the rest and caps at 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => `scope.${i}`);
    const e = new ConnectorError('auth_expired', 'x_code', {
      missingScopes: ['comment.list', 'Bad Scope', 'a'.repeat(65), '', ...many],
    });
    expect(e.missingScopes).toHaveLength(20);
    expect(e.missingScopes?.[0]).toBe('comment.list');
    expect(e.missingScopes).not.toContain('Bad Scope');
  });

  it('keeps hyphenated scope names such as youtube.force-ssl', () => {
    const e = new ConnectorError('auth_expired', 'x_code', {
      missingScopes: ['youtube.force-ssl', 'a/b', 'a b'],
    });
    expect(e.missingScopes).toEqual(['youtube.force-ssl']);
  });

  it('is undefined when absent or when nothing valid remains', () => {
    expect(new ConnectorError('auth_expired', 'x_code').missingScopes).toBeUndefined();
    expect(
      new ConnectorError('auth_expired', 'x_code', { missingScopes: ['No Good'] }).missingScopes,
    ).toBeUndefined();
  });
});
