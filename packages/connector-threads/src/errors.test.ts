import { describe, expect, it } from 'vitest';
import { mapThreadsError } from './errors.js';

const e = (httpStatus: number, code: number | null, subcode: number | null = null) =>
  mapThreadsError({ httpStatus, code, subcode, retryAfterMs: null });

describe('mapThreadsError', () => {
  it.each([
    [401, 190, null, 'auth_expired', 'token_invalid'],
    [400, 102, null, 'auth_expired', 'token_invalid'],
    [400, 4, null, 'rate_limited', 'throttled'],
    [400, 17, null, 'rate_limited', 'throttled'],
    [400, 32, null, 'rate_limited', 'throttled'],
    [400, 613, null, 'rate_limited', 'throttled'],
    [429, null, null, 'rate_limited', 'throttled'],
    [400, 4, 2207051, 'rate_limited', 'reply_quota_exhausted'],
    [400, 100, 33, 'not_found', 'media_not_found'],
    [404, null, null, 'not_found', 'media_not_found'],
    [403, 10, null, 'permanent', 'permission_denied'],
    [403, 200, null, 'permanent', 'permission_denied'],
    [403, 299, null, 'permanent', 'permission_denied'],
    [500, 1, null, 'transient', 'threads_unavailable'],
    [500, 2, null, 'transient', 'threads_unavailable'],
    [503, null, null, 'transient', 'threads_unavailable'],
    [400, 100, null, 'permanent', 'threads_error_100'],
    [400, null, null, 'permanent', 'threads_http_400'],
  ] as const)('HTTP %s code %s subcode %s', (status, code, sub, kind, mapped) => {
    expect(e(status, code, sub)).toMatchObject({ kind, code: mapped });
  });

  it('carries retryAfterMs only on rate limits', () => {
    expect(
      mapThreadsError({ httpStatus: 429, code: null, subcode: null, retryAfterMs: 5000 })
        .retryAfterMs,
    ).toBe(5000);
    expect(
      mapThreadsError({ httpStatus: 500, code: 1, subcode: null, retryAfterMs: 5000 }).retryAfterMs,
    ).not.toBe(5000);
  });
});
