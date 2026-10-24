import { describe, expect, it } from 'vitest';
import {
  adVideoPermalink,
  numericId,
  opaqueId,
  safeShareUrl,
  sanitizeText,
  tiktokTime,
  username,
} from './ids.js';

describe('ids', () => {
  it.each(['1', '7300000000000000001'])('numericId accepts %s', (v) =>
    expect(numericId(v)).toBe(v),
  );
  it.each(['', 'act_1', '1 ', '../1', '1?x', 'x'.repeat(33), 12, null])(
    'numericId rejects %s',
    (v) =>
      expect(() => numericId(v)).toThrow(expect.objectContaining({ code: 'invalid_tiktok_id' })),
  );

  it('opaqueId accepts open_id-style values and rejects path/control characters', () => {
    expect(opaqueId('-000AbC_d.e:f=')).toBe('-000AbC_d.e:f=');
    expect(opaqueId('ab+cd')).toBe('ab+cd');
    for (const bad of ['a/../b', 'a b', 'a\u0000', 'a?b', 'x'.repeat(129)])
      expect(() => opaqueId(bad)).toThrow(expect.objectContaining({ code: 'invalid_tiktok_id' }));
  });

  it('username returns a valid handle or null', () => {
    expect(username('brand_x.1')).toBe('brand_x.1');
    expect(username('a b')).toBeNull();
    expect(username('a'.repeat(24))).toBe('a'.repeat(24));
    expect(username('a'.repeat(25))).toBeNull();
    expect(username(5)).toBeNull();
  });

  it('sanitizeText replaces NUL and truncates by code point, keeping emoji intact', () => {
    expect(sanitizeText('a\u0000b', 10)).toBe('a�b');
    expect(sanitizeText('👨‍👩‍👧🔥', 1)).toBe('👨');
    expect(sanitizeText('مرحبا 你好', 100)).toBe('مرحبا 你好');
  });

  it('safeShareUrl allows only https www.tiktok.com / vm.tiktok.com', () => {
    expect(safeShareUrl('https://www.tiktok.com/@brand/video/1')).toBe(
      'https://www.tiktok.com/@brand/video/1',
    );
    expect(safeShareUrl('https://vm.tiktok.com/abc/')).toBe('https://vm.tiktok.com/abc/');
    for (const bad of [
      'http://www.tiktok.com/x',
      'https://evil.example/x',
      'https://www.tiktok.com.evil.example/',
      'javascript:alert(1)',
      'https://user@www.tiktok.com/',
      42,
    ])
      expect(safeShareUrl(bad)).toBeNull();
  });

  it('adVideoPermalink is null unless item id is numeric', () => {
    expect(adVideoPermalink('123')).toBe('https://www.tiktok.com/@/video/123');
    expect(adVideoPermalink('../x')).toBeNull();
  });

  it('tiktokTime parses unix seconds and the Marketing API datetime as UTC', () => {
    expect(tiktokTime(1730000000).toISOString()).toBe('2024-10-27T03:33:20.000Z');
    expect(tiktokTime('1730000000').toISOString()).toBe('2024-10-27T03:33:20.000Z');
    expect(tiktokTime('2026-10-24 10:00:00').toISOString()).toBe('2026-10-24T10:00:00.000Z');
    for (const bad of ['yesterday', -1, 1.5, null, '2026-13-45 99:00:00'])
      expect(() => tiktokTime(bad)).toThrow(
        expect.objectContaining({ code: 'invalid_tiktok_response' }),
      );
  });
});
