import { describe, expect, it } from 'vitest';
import { Secret } from '@feedbouncer/service-runtime';
import { assertSafePayload, validateJobResult } from './payload.js';

describe('assertSafePayload', () => {
  it('returns JSON for plain JSON objects (user content allowed)', () => {
    expect(assertSafePayload({ commentId: 'c1', body: '<script>alert(1)</script>' })).toBe(
      '{"commentId":"c1","body":"<script>alert(1)</script>"}',
    );
  });
  it.each([
    [{ accessToken: 'x' }, 'payload_contains_secret'],
    [{ nested: [{ refresh_token: 'x' }] }, 'payload_contains_secret'],
    [{ a: new Secret('s3cr3t') }, 'payload_contains_secret'],
    [{ a: 'x'.repeat(70_000) }, 'payload_too_large'],
    [[1, 2], 'invalid_payload'],
    [{ d: new Date() }, 'invalid_payload'],
    [{ n: Number.NaN }, 'invalid_payload'],
    [{ f: () => 1 }, 'invalid_payload'],
    [JSON.parse('{"__proto__":{"x":1}}'), 'invalid_payload'],
  ])('rejects %o with %s', (payload, code) => {
    expect(() => assertSafePayload(payload)).toThrow(expect.objectContaining({ code }));
  });
  it('rejects deep nesting', () => {
    let v: unknown = {};
    for (let i = 0; i < 40; i++) v = { v };
    expect(() => assertSafePayload(v)).toThrow(
      expect.objectContaining({ code: 'invalid_payload' }),
    );
  });
  it('never echoes the secret value in the error', () => {
    expect(() => assertSafePayload({ token: 'hunter2' })).toThrow(
      expect.objectContaining({ code: 'payload_contains_secret' }),
    );
    try {
      assertSafePayload({ token: 'hunter2' });
    } catch (e) {
      expect(String(e)).not.toContain('hunter2');
    }
  });
});

describe('validateJobResult', () => {
  it('accepts flat primitive records', () => {
    expect(
      validateJobResult({ status: 'applied', platformActionId: null, n: 1, ok: true }),
    ).toEqual({ status: 'applied', platformActionId: null, n: 1, ok: true });
  });
  it.each([
    [null],
    [[]],
    [{ nested: {} }],
    [{ accessToken: 'x' }],
    [{ s: 'x'.repeat(9_000) }],
    [{ 'bad key': 1 }],
  ])('rejects %o', (r) => {
    expect(() => validateJobResult(r)).toThrow('non_retryable: invalid_job_result');
  });
});
