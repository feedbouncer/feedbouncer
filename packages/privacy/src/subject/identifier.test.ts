import { describe, expect, it } from 'vitest';
import { SubjectIdentifier, SubjectList } from './identifier.js';

const ok = (v: unknown) => SubjectIdentifier.safeParse(v).success;

describe('SubjectIdentifier', () => {
  it('rejects an identifier with neither an external id nor a handle', () => {
    expect(ok({})).toBe(false);
    expect(ok({ platform: 'facebook' })).toBe(false);
  });
  it('rejects an unknown key', () => {
    expect(ok({ platform: 'facebook', externalId: '1', displayName: 'x' })).toBe(false);
  });
  it('rejects an unknown platform', () => {
    expect(ok({ platform: 'myspace', externalId: '1' })).toBe(false);
  });
  it('bounds the external id at 255 characters', () => {
    expect(ok({ platform: 'facebook', externalId: 'x'.repeat(255) })).toBe(true);
    expect(ok({ platform: 'facebook', externalId: 'x'.repeat(256) })).toBe(false);
  });
  it('bounds the handle at 100 characters', () => {
    expect(ok({ platform: 'facebook', handle: 'x'.repeat(100) })).toBe(true);
    expect(ok({ platform: 'facebook', handle: 'x'.repeat(101) })).toBe(false);
  });
  it('rejects control characters', () => {
    expect(ok({ platform: 'facebook', externalId: 'a\u0000b' })).toBe(false);
    expect(ok({ platform: 'facebook', externalId: 'a\nb' })).toBe(false);
    expect(ok({ platform: 'facebook', handle: 'a\tb' })).toBe(false);
  });
  it('rejects an empty external id and a connection id that is not a uuid', () => {
    expect(ok({ platform: 'facebook', externalId: '' })).toBe(false);
    expect(ok({ platform: 'facebook', externalId: '1', connectionId: 'abc' })).toBe(false);
  });
  it('accepts a handle alone, and an external id with a connection id', () => {
    expect(ok({ platform: 'facebook', handle: 'x' })).toBe(true);
    expect(
      ok({
        platform: 'instagram',
        externalId: "O'Brien%_\\",
        connectionId: '0b9e8a52-6a3c-4c1f-9d1e-1f2a3b4c5d6e',
      }),
    ).toBe(true);
  });
});

describe('SubjectList', () => {
  const id = { platform: 'facebook', externalId: '1' };
  it('takes 1 to 20 identifiers', () => {
    expect(SubjectList.safeParse([]).success).toBe(false);
    expect(SubjectList.safeParse(Array.from({ length: 20 }, () => id)).success).toBe(true);
    expect(SubjectList.safeParse(Array.from({ length: 21 }, () => id)).success).toBe(false);
  });
});
