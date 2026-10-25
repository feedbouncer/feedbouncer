import { describe, expect, it } from 'vitest';
import {
  MEDIA_ID,
  mediaId,
  safeCursor,
  safePermalink,
  sanitizeText,
  threadsTime,
  username,
} from './ids.js';

describe('mediaId', () => {
  it('accepts 1 to 32 digits', () => {
    expect(mediaId('17890')).toBe('17890');
    expect(MEDIA_ID.test('1'.repeat(32))).toBe(true);
  });
  it.each(['', 'abc', '1/2', '../1', '1'.repeat(33), 12, null, undefined, '1\n'])(
    'rejects %j',
    (v) =>
      expect(() => mediaId(v)).toThrow(
        expect.objectContaining({ kind: 'permanent', code: 'invalid_threads_id' }),
      ),
  );
});

describe('username', () => {
  it('accepts handles', () => expect(username('a.b_c1')).toBe('a.b_c1'));
  it.each(['a b', '<script>', 'a'.repeat(31), '', 5, null])('rejects %j', (v) =>
    expect(username(v)).toBeNull(),
  );
});

describe('sanitizeText', () => {
  it('replaces NUL', () => expect(sanitizeText('a\u0000b', 10)).toBe('a�b'));
  it('truncates by code point without splitting a pair', () =>
    expect(sanitizeText('👨‍👩‍👧🔥', 1)).toBe('👨'));
  it('non-string is empty', () => {
    expect(sanitizeText(undefined, 10)).toBe('');
    expect(sanitizeText(42, 10)).toBe('');
  });
  it('keeps RTL, CJK and symbols', () => {
    const s = 'مرحبا 你好 ﷽';
    expect(sanitizeText(s, 100)).toBe(s);
  });
});

describe('safePermalink', () => {
  it.each([
    'https://www.threads.com/@a/post/Pp',
    'https://www.threads.net/@a/post/Pp',
    'https://threads.com/@a',
    'https://threads.net/@a',
  ])('accepts %s', (u) => expect(safePermalink(u)).toBe(u));
  it.each([
    'http://www.threads.com/@a',
    'https://threads.com.evil.example/',
    'https://u@www.threads.com/',
    'javascript:alert(1)',
    42,
    'not a url',
    null,
  ])('rejects %j', (u) => expect(safePermalink(u)).toBeNull());
});

describe('safeCursor', () => {
  it('accepts opaque tokens', () => expect(safeCursor('QVFIU_x-y=')).toBe('QVFIU_x-y='));
  it.each(['', 'a b', 'a&b=1', 'a'.repeat(513), 3, null])('rejects %j', (v) =>
    expect(safeCursor(v)).toBeNull(),
  );
});

describe('threadsTime', () => {
  it('parses +0000 offsets', () =>
    expect(threadsTime('2024-08-07T10:33:16+0000').toISOString()).toBe('2024-08-07T10:33:16.000Z'));
  it('parses Z and colon offsets', () => {
    expect(threadsTime('2024-08-07T10:33:16Z').toISOString()).toBe('2024-08-07T10:33:16.000Z');
    expect(threadsTime('2024-08-07T12:33:16+02:00').toISOString()).toBe('2024-08-07T10:33:16.000Z');
  });
  it.each(['yesterday', '', 5, null, '2024-13-45T00:00:00+0000'])('rejects %j', (v) =>
    expect(() => threadsTime(v)).toThrow(
      expect.objectContaining({ kind: 'permanent', code: 'invalid_threads_response' }),
    ),
  );
});
