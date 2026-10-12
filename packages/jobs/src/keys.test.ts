import { describe, expect, it } from 'vitest';
import { bullJobId, deriveIdempotencyKey } from './keys.js';

const A = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  brandId: '00000000-0000-4000-8000-000000000002',
  connectionId: '00000000-0000-4000-8000-000000000003',
};
const B = { ...A, organizationId: '00000000-0000-4000-8000-000000000009' };

describe('deriveIdempotencyKey', () => {
  const base = {
    scope: A,
    platform: 'facebook',
    type: 'hide_comment',
    externalRef: 'c1:hide',
  } as const;
  it('is deterministic 64-hex', () => {
    const k = deriveIdempotencyKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveIdempotencyKey(base)).toBe(k);
  });
  it('is tenant-scoped: same external id, different organization, brand or connection -> different key', () => {
    const k = deriveIdempotencyKey(base);
    expect(deriveIdempotencyKey({ ...base, scope: B })).not.toBe(k);
    expect(deriveIdempotencyKey({ ...base, scope: { ...A, brandId: B.organizationId } })).not.toBe(
      k,
    );
    expect(
      deriveIdempotencyKey({ ...base, scope: { ...A, connectionId: B.organizationId } }),
    ).not.toBe(k);
  });
  it('separates platform, type, and ref-vs-caller keys', () => {
    const k = deriveIdempotencyKey(base);
    expect(deriveIdempotencyKey({ ...base, platform: 'youtube' })).not.toBe(k);
    expect(deriveIdempotencyKey({ ...base, type: 'delete_comment' })).not.toBe(k);
    expect(
      deriveIdempotencyKey({
        scope: A,
        platform: 'facebook',
        type: 'hide_comment',
        callerKey: 'c1:hide',
      }),
    ).not.toBe(k);
  });
  it('cannot be confused by delimiter injection', () => {
    const k1 = deriveIdempotencyKey({ ...base, type: 'a', externalRef: 'b:c' });
    const k2 = deriveIdempotencyKey({ ...base, type: 'a_b', externalRef: 'c' });
    expect(k1).not.toBe(k2);
  });
  it.each(['', 'x'.repeat(257), 'has space', 'nul\u0000', 'emoji\u{1F600}'])(
    'rejects external ref %j',
    (externalRef) => {
      expect(() => deriveIdempotencyKey({ ...base, externalRef })).toThrow(
        'invalid_idempotency_key',
      );
    },
  );
  it('hashes refs with path characters; they are never used as paths', () => {
    expect(deriveIdempotencyKey({ ...base, externalRef: '../../etc' })).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects an oversized or control-character caller key', () => {
    expect(() =>
      deriveIdempotencyKey({ scope: A, platform: 'facebook', type: 't', callerKey: 'a\nb' }),
    ).toThrow('invalid_idempotency_key');
    expect(() =>
      deriveIdempotencyKey({
        scope: A,
        platform: 'facebook',
        type: 't',
        callerKey: 'k'.repeat(257),
      }),
    ).toThrow('invalid_idempotency_key');
  });
  it('builds a colon-free BullMQ id', () => {
    expect(bullJobId('a'.repeat(64))).toBe(`j_${'a'.repeat(64)}`);
  });
});
