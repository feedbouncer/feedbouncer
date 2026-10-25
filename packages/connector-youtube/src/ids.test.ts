import { describe, expect, it } from 'vitest';
import { ConnectorError } from '@feedbouncer/connectors';
import { assertId, CHANNEL_ID, COMMENT_ID, PAGE_TOKEN, VIDEO_ID } from './ids.js';

const invalid = { kind: 'permanent', code: 'invalid_platform_id' };

describe('assertId', () => {
  it('rejects malformed ids and tokens', () => {
    expect(() => assertId('comment', 'Ug../../x')).toThrow(ConnectorError);
    expect(() => assertId('comment', 'Ug../../x')).toThrow(expect.objectContaining(invalid));
    expect(() => assertId('video', 'abc&x=1')).toThrow(expect.objectContaining(invalid));
    expect(() => assertId('channel', 'UC' + 'a'.repeat(21))).toThrow(
      expect.objectContaining(invalid),
    );
    expect(assertId('comment', 'UgxAbC123_-.def')).toBe('UgxAbC123_-.def');
    expect(PAGE_TOKEN.test('a?b')).toBe(false);
  });

  it('accepts well-formed ids of each kind', () => {
    const channel = 'UC' + 'a'.repeat(22);
    expect(assertId('channel', channel)).toBe(channel);
    expect(assertId('video', 'dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(assertId('thread', 'UgzThread123')).toBe('UgzThread123');
    expect(assertId('pageToken', 'CDIQAA')).toBe('CDIQAA');
  });

  it('rejects non-strings, empty values and oversize ids without echoing them', () => {
    for (const v of [undefined, null, 42, '', 'x'.repeat(201)]) {
      expect(() => assertId('comment', v)).toThrow(expect.objectContaining(invalid));
    }
    try {
      assertId('video', 'evil<script>');
    } catch (err) {
      expect(String(err)).not.toContain('evil');
    }
  });

  it('patterns are anchored', () => {
    expect(CHANNEL_ID.test('xUC' + 'a'.repeat(22))).toBe(false);
    expect(VIDEO_ID.test('dQw4w9WgXcQ\n')).toBe(false);
    expect(COMMENT_ID.test('UgxAbC123/def')).toBe(false);
    expect(PAGE_TOKEN.test('x'.repeat(513))).toBe(false);
  });
});
