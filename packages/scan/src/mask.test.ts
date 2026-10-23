import { expect, test } from 'vitest';
import { clipText, maskAuthor, normalizeText } from './mask.js';

test('maskAuthor', () => {
  expect(maskAuthor('jane van doe')).toBe('J. V.');
  expect(maskAuthor(null)).toBe('Unknown');
  expect(maskAuthor('  ')).toBe('Unknown');
  expect(maskAuthor('😀x')).toBe('😀.');
});

test('clipText cuts at code points and replaces NUL', () => {
  expect(clipText('a\0b')).toBe('a�b');
  const clipped = clipText('😀'.repeat(300));
  expect([...clipped]).toHaveLength(281);
  expect(clipped.endsWith('…')).toBe(true);
  expect(clipText('short')).toBe('short');
});

test('normalizeText', () => expect(normalizeText('  ＨＥＬＬＯ \n  World ')).toBe('hello world'));
