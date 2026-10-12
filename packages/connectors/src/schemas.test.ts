import { describe, expect, it } from 'vitest';
import { ConnectorError } from './errors.js';
import { commentSchema, parseComment, parsePage } from './schemas.js';

const good = {
  externalId: 'c1',
  sourceExternalId: 's1',
  parentExternalId: null,
  author: { externalId: 'u1', displayName: 'Dana', profileUrl: 'https://example.test/u1' },
  body: 'hello',
  postedAt: new Date('2026-10-01T00:00:00Z'),
  platformState: 'visible',
  permalink: 'https://example.test/c1',
} as const;

const invalid = (raw: unknown) => {
  try {
    parseComment(raw);
  } catch (e) {
    return e instanceof ConnectorError ? e.info() : 'wrong error type';
  }
  return 'accepted';
};
const INVALID = {
  kind: 'permanent',
  code: 'invalid_connector_output',
  retryAfterMs: null,
  reauthorize: false,
};

describe('comment boundary schema', () => {
  it('accepts a well-formed comment', () => {
    expect(parseComment(good)).toEqual(good);
  });

  it.each([
    ['javascript: permalink', { ...good, permalink: 'javascript:alert(1)' }],
    ['http permalink', { ...good, permalink: 'http://example.test/c1' }],
    ['data: avatar url', { ...good, author: { ...good.author, profileUrl: 'data:text/html,x' } }],
    ['oversized body', { ...good, body: 'x'.repeat(100_001) }],
    ['control char in id', { ...good, externalId: 'c1\n' }],
    ['empty id', { ...good, externalId: '' }],
    ['id longer than 255', { ...good, externalId: 'x'.repeat(256) }],
    ['self parent', { ...good, parentExternalId: 'c1' }],
    ['invalid date', { ...good, postedAt: new Date('nope') }],
    ['unknown state', { ...good, platformState: 'shadowbanned' }],
    ['unknown key', { ...good, extra: 1 }],
  ])('rejects %s', (_name, raw) => {
    expect(invalid(raw)).toEqual(INVALID);
  });

  it('replaces NUL characters in bodies and author names', () => {
    expect(parseComment({ ...good, body: 'a\u0000b' }).body).toBe('a�b');
    expect(
      parseComment({ ...good, author: { ...good.author, displayName: 'D\u0000a' } }).author
        ?.displayName,
    ).toBe('D\uFFFDa');
  });

  it('does not echo the rejected input in the error', () => {
    try {
      parseComment({ ...good, body: 1, permalink: 'javascript:SENTINEL' });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('SENTINEL');
      expect(JSON.stringify(e)).not.toContain('SENTINEL');
    }
  });
});

describe('parsePage', () => {
  it('drops duplicate external ids within a page', () => {
    const page = parsePage(commentSchema, { items: [good, good], nextCursor: 'n1' });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('n1');
  });

  it('rejects oversized cursors', () => {
    expect(() => parsePage(commentSchema, { items: [], nextCursor: 'x'.repeat(2049) })).toThrow(
      ConnectorError,
    );
  });
});
