import { describe, expect, it } from 'vitest';
import { mapTikTokError } from './errors.js';

const e = (code: number | null, httpStatus = 200, retryAfterMs: number | null = null) =>
  mapTikTokError({ httpStatus, code, retryAfterMs });

describe('mapTikTokError', () => {
  it.each([
    [40100, 200, 'rate_limited', 'throttled'],
    [40001, 200, 'permanent', 'permission_denied'],
    [40002, 200, 'permanent', 'invalid_request'],
    [40102, 200, 'auth_expired', 'token_invalid'],
    [40104, 200, 'auth_expired', 'token_invalid'],
    [40105, 200, 'auth_expired', 'token_invalid'],
    [40400, 200, 'not_found', 'comment_not_found'],
    [50000, 200, 'transient', 'tiktok_unavailable'],
    [59999, 200, 'transient', 'tiktok_unavailable'],
    [null, 429, 'rate_limited', 'throttled'],
    [null, 500, 'transient', 'tiktok_unavailable'],
    [null, 503, 'transient', 'tiktok_unavailable'],
    [41234, 200, 'permanent', 'tiktok_error_41234'],
  ] as const)('code %s / http %s -> %s/%s', (code, http, kind, mapped) => {
    expect(e(code, http)).toMatchObject({ kind, code: mapped });
  });

  it('carries retryAfterMs on throttles and leaves it null otherwise', () => {
    expect(e(40100, 200, 5000).retryAfterMs).toBe(5000);
    expect(e(40100).retryAfterMs).toBeNull();
  });

  it('an unmapped 4xx with no code is a permanent http error', () => {
    expect(e(null, 404)).toMatchObject({ kind: 'permanent', code: 'tiktok_http_404' });
  });
});
