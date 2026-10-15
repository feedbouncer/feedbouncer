import { describe, expect, it } from 'vitest';
import { extractLinks } from './links.js';

const hosts = (s: string) => extractLinks(s).map((l) => l.host);

describe('extractLinks', () => {
  it('finds scheme and schemeless links, lower-cased, without www stripping', () => {
    expect(hosts('see https://WWW.Example.com/a and shop.example.co.uk/b, ok?')).toEqual([
      'www.example.com',
      'shop.example.co.uk',
    ]);
  });
  it('strips trailing punctuation and surrounding brackets', () => {
    expect(hosts('(visit evil.io).')).toEqual(['evil.io']);
    expect(hosts('go to "bit.ly/x"!')).toEqual(['bit.ly']);
  });
  it('uses the real host for userinfo tricks', () => {
    expect(hosts('https://example.com@evil.io/login')).toEqual(['evil.io']);
  });
  it('keeps lookalike suffix domains intact', () => {
    expect(hosts('example.com.evil.io/path')).toEqual(['example.com.evil.io']);
  });
  it('converts IDN to punycode and flags mixed-script labels', () => {
    const [l] = extractLinks('https://еxample.com'); // Cyrillic е
    expect(l!.host).toMatch(/^xn--/);
    expect(l!.mixedScript).toBe(true);
    expect(l!.skeleton).toBe('example.com');
    const [ok] = extractLinks('español.com');
    expect(ok).toMatchObject({ host: 'xn--espaol-zwa.com', mixedScript: false });
  });
  it('defeats zero-width and full-width dot obfuscation', () => {
    expect(hosts('evil​.io and bad．io')).toEqual(['evil.io', 'bad.io']);
  });
  it('ignores emails, version numbers, file names, decimals and "dot" spelling', () => {
    expect(hosts('mail me@x.com, v1.2.3, file.txt, 3.14, example dot com')).toEqual([]);
  });
  it('ignores IP-literal schemeless tokens but keeps scheme URLs to IPs', () => {
    expect(hosts('1.2.3.4')).toEqual([]);
    expect(hosts('http://1.2.3.4/x')).toEqual(['1.2.3.4']);
  });
  it('dedupes and caps the number of links at 50', () => {
    expect(hosts('a.com a.com A.COM')).toEqual(['a.com']);
    const many = Array.from({ length: 80 }, (_, i) => `x${i}.com`).join(' ');
    expect(extractLinks(many)).toHaveLength(50);
  });
  it('returns [] for empty and emoji-only text', () => {
    expect(extractLinks('')).toEqual([]);
    expect(extractLinks('🔥🔥🔥')).toEqual([]);
  });
});
