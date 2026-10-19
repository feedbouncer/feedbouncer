import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, InvalidCursorError } from './cursor.js';

const position = {
  t: new Date('2026-10-18T10:20:30.123Z'),
  id: '3f1f5f7e-9381-4c0a-8a0c-5b6de5e7b6d1',
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

describe('cursor codec', () => {
  it('round-trips with the same filters', () => {
    expect(
      decodeCursor(encodeCursor(position, { status: 'hidden' }), { status: 'hidden' }),
    ).toEqual(position);
  });

  it('ignores undefined filters', () => {
    const raw = encodeCursor(position, { status: 'hidden', brandId: undefined });
    expect(decodeCursor(raw, { status: 'hidden' })).toEqual(position);
  });

  it('rejects a cursor replayed with other filters', () => {
    const raw = encodeCursor(position, { status: 'hidden' });
    expect(() => decodeCursor(raw, { status: 'visible' })).toThrow(InvalidCursorError);
    expect(() => decodeCursor(raw, { status: 'hidden', brandId: position.id })).toThrow(
      InvalidCursorError,
    );
  });

  it('rejects garbage, wrong version and non-uuid ids', () => {
    const good = { v: 1, t: position.t.toISOString(), id: position.id, f: '0123456789abcdef' };
    expect(() => decodeCursor('not-base64!!', {})).toThrow(InvalidCursorError);
    expect(() => decodeCursor(b64({ ...good, v: 2 }), {})).toThrow(InvalidCursorError);
    expect(() => decodeCursor(b64({ ...good, id: '1 OR 1=1' }), {})).toThrow(InvalidCursorError);
    expect(() => decodeCursor(b64({ ...good, t: 'yesterday' }), {})).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('{').toString('base64url'), {})).toThrow(
      InvalidCursorError,
    );
  });
});
