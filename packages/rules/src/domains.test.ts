import { describe, expect, it } from 'vitest';
import { isUnder, latinSkeleton, normalizeDomainEntry } from './domains.js';

describe('normalizeDomainEntry', () => {
  it.each([
    ['Example.COM', 'example.com'],
    ['https://www.example.com/path?q=1', 'example.com'],
    ['*.example.com', 'example.com'],
    ['shop.example.co.uk', 'shop.example.co.uk'],
    ['español.com', 'xn--espaol-zwa.com'],
    ['example.com.', 'example.com'],
  ])('%s -> %s', (input, out) => expect(normalizeDomainEntry(input)).toBe(out));
  it.each([
    '',
    'not a domain',
    'localhost',
    'com',
    '1.2.3.4',
    'http://',
    'a'.repeat(254) + '.com',
    'xn--iñvalid.com',
    '../../etc/passwd',
  ])('rejects %j', (input) => expect(normalizeDomainEntry(input)).toBeNull());
});

describe('isUnder', () => {
  it('matches the domain and its subdomains on label boundaries only', () => {
    expect(isUnder('example.com', 'example.com')).toBe(true);
    expect(isUnder('www.example.com', 'example.com')).toBe(true);
    expect(isUnder('a.b.example.com', 'example.com')).toBe(true);
    expect(isUnder('badexample.com', 'example.com')).toBe(false);
    expect(isUnder('example.com.evil.io', 'example.com')).toBe(false);
  });
});

describe('latinSkeleton', () => {
  it('maps common Cyrillic/Greek confusables to Latin', () => {
    expect(latinSkeleton('еxample.com')).toBe('example.com'); // Cyrillic e
    expect(latinSkeleton('ехаmрlе.com')).toBe('example.com');
    expect(latinSkeleton('example.com')).toBe('example.com');
  });
});
