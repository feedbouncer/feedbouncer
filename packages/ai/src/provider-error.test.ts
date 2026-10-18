import { APICallError, NoObjectGeneratedError } from 'ai';
import { describe, expect, it } from 'vitest';
import { mapProviderError } from './provider-error.js';

describe('mapProviderError', () => {
  const api = (statusCode: number) =>
    new APICallError({
      message: 'secret-bearing message',
      url: 'https://api.example.com',
      requestBodyValues: {},
      statusCode,
      isRetryable: statusCode >= 500,
    });
  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [429, 'rate_limited', true],
    [400, 'bad_request', false],
    [404, 'bad_request', false],
    [408, 'unavailable', true],
    [500, 'unavailable', true],
    [503, 'unavailable', true],
  ])('HTTP %i → %s (retryable=%s)', (status, code, retryable) => {
    const e = mapProviderError(api(status));
    expect(e).toMatchObject({ code, retryable });
    expect(e.message).not.toContain('secret-bearing');
  });
  it('unknown errors are unavailable and retryable', () => {
    expect(mapProviderError(new Error('boom'))).toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
  });
  it('keeps usage from NoObjectGeneratedError', () => {
    const e = mapProviderError(
      new NoObjectGeneratedError({
        message: 'x',
        response: { id: 'r', timestamp: new Date(), modelId: 'm' },
        usage: { inputTokens: 50, outputTokens: 200 } as never,
        finishReason: 'length',
      }),
    );
    expect(e.code).toBe('invalid_output');
    expect(e.usage).toEqual({ inputTokens: 50, outputTokens: 200, cacheReadTokens: null });
  });
  it('other mappings carry no usage', () => {
    expect(mapProviderError(new Error('boom')).usage).toBeNull();
    expect(mapProviderError(api(500)).usage).toBeNull();
  });
});
