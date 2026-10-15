import { describe, expect, it } from 'vitest';
import { extractLinks, extractLinksDetailed } from './links.js';

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
    const [l] = extractLinks('https://\u0435xample.com'); // Cyrillic e
    expect(l!.host).toMatch(/^xn--/);
    expect(l!.mixedScript).toBe(true);
    expect(l!.skeleton).toBe('example.com');
    const [ok] = extractLinks('espa\u00F1ol.com');
    expect(ok).toMatchObject({ host: 'xn--espaol-zwa.com', mixedScript: false });
  });
  it('defeats zero-width and full-width dot obfuscation', () => {
    expect(hosts('evil\u200B.io and bad\uFF0Eio')).toEqual(['evil.io', 'bad.io']);
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
    expect(extractLinks('\u{1F525}\u{1F525}\u{1F525}')).toEqual([]);
  });
  describe('fail-closed hardening', () => {
    it('keeps userinfo URLs without a scheme, but not plain e-mail addresses', () => {
      expect(hosts('name@evil.io/path')).toEqual(['evil.io']);
      expect(hosts('user:pw@evil.io')).toEqual(['evil.io']);
      expect(hosts('a@b@evil.io/x?y=1')).toEqual(['evil.io']);
      expect(hosts('me@x.com')).toEqual([]);
    });
    it('emits both views of a backslash userinfo trick', () => {
      expect(hosts('https://example.com\\@evil.io').sort()).toEqual(['evil.io', 'example.com']);
      expect(hosts('example.com\\@evil.io/x').sort()).toEqual(['evil.io', 'example.com']);
    });
    it('handles scheme-relative and malformed-slash special schemes like a browser', () => {
      expect(hosts('//evil.io/x')).toEqual(['evil.io']);
      expect(hosts('https:/evil.io')).toEqual(['evil.io']);
      expect(hosts('http:evil.io')).toEqual(['evil.io']);
      expect(hosts('https:/\\evil.io')).toEqual(['evil.io']);
    });
    it('does not skip very long tokens', () => {
      expect(hosts(`https://evil.io/${'a'.repeat(5000)}`)).toEqual(['evil.io']);
      expect(hosts(`evil.io/${'a'.repeat(5000)}`)).toEqual(['evil.io']);
    });
    it('splits comma and semicolon joined links and ignores markdown decoration', () => {
      expect(hosts('evil.io,evil2.io;evil3.io')).toEqual(['evil.io', 'evil2.io', 'evil3.io']);
      expect(hosts('https://a.com,https://b.com')).toEqual(['a.com', 'b.com']);
      expect(hosts('*evil.io* _bad.io_')).toEqual(['evil.io', 'bad.io']);
    });
    it('reports when the link cap truncated the result', () => {
      const many = Array.from({ length: 80 }, (_, i) => `x${i}.com`).join(' ');
      expect(extractLinksDetailed(many)).toMatchObject({ truncated: true });
      expect(extractLinksDetailed('a.com')).toMatchObject({ truncated: false });
    });
  });
  describe('browser differential (round 2)', () => {
    it('joins URLs that WHATWG parsing would de-tab', () => {
      expect(hosts('https://exa\tmple.com')).toContain('example.com');
      expect(hosts('https://exa\nmple.com/x')).toContain('example.com');
      expect(hosts('https://a.com\t,b.com')).toEqual(expect.arrayContaining(['a.com', 'b.com']));
      expect(hosts('see\nevil.io')).toEqual(['evil.io']);
    });
    it('ignores leading control characters', () => {
      expect(hosts('\u0001evil.io')).toEqual(['evil.io']);
      expect(hosts('https://evil.io\u0001')).toEqual(['evil.io']);
    });
    it('emits IPv6 literal URLs', () => {
      expect(hosts('http://[::1]/x')).toEqual(['[::1]']);
      expect(hosts('[https://evil.io]')).toEqual(['evil.io']);
    });
    it('emits the host-like userinfo of a schemeless user:port@host form too', () => {
      expect(hosts('evil.io:80@good.com')).toEqual(expect.arrayContaining(['evil.io', 'good.com']));
    });
    it('strips any leading punctuation run', () => {
      expect(hosts('=evil.io !bad.io -worse.io @x.io')).toEqual([
        'evil.io',
        'bad.io',
        'worse.io',
        'x.io',
      ]);
    });
    it('flags truncation for over-length tokens', () => {
      const r = extractLinksDetailed(`https://evil.io/${'a'.repeat(5000)}`);
      expect(r.truncated).toBe(true);
      expect(r.links.map((l) => l.host)).toEqual(['evil.io']);
    });
    it('does not treat scheme-relative single labels as links', () => {
      expect(hosts('//todo')).toEqual([]);
      expect(hosts('//evil.io')).toEqual(['evil.io']);
    });
    it('does not split numbers on a comma between digits', () => {
      expect(hosts('see 1,000.com')).toEqual(['000.com']);
      expect(hosts('1,000.com')).toEqual(['000.com']);
      expect(hosts('a1,000.com')).toEqual(['000.com']);
      expect(hosts('evil.io,evil2.io')).toEqual(['evil.io', 'evil2.io']);
    });
    it('handles long punctuation runs in linear time', () => {
      const t = Date.now();
      extractLinks(`evil.io${'.'.repeat(50000)}x`);
      extractLinks(`${'.,'.repeat(20000)}`);
      expect(Date.now() - t).toBeLessThan(1000);
    });
  });
  describe('browser differential (round 3)', () => {
    it('finds schemes in the middle of a token and concatenated URLs', () => {
      expect(hosts('see:https://evil.io')).toEqual(['evil.io']);
      expect(hosts('https://a.com/https://evil.io')).toEqual(['a.com', 'evil.io']);
      expect(hosts('https://a.comhttps://evil.io')).toContain('evil.io');
    });
    it('finds hosts after = and & in attributes and query strings', () => {
      expect(hosts('<a href=https://evil.io>x</a>')).toEqual(['evil.io']);
      expect(hosts('href=evil.io')).toEqual(['evil.io']);
      expect(hosts('src=//evil.io/x')).toEqual(['evil.io']);
      expect(hosts('a.com/x?u=evil.io&v=1')).toEqual(['a.com', 'evil.io']);
    });
    it('finds hosts followed directly by non-ASCII text or punctuation', () => {
      expect(hosts('evil.io、next')).toEqual(['evil.io']);
      expect(hosts('evil.io中文')).toContain('evil.io');
    });
    it('keeps underscores and colon-prefixed or colon-suffixed hosts', () => {
      expect(hosts('evil_x.io')).toEqual(['evil_x.io']);
      expect(hosts('see:evil.io')).toEqual(['evil.io']);
      expect(hosts('evil.io:abc')).toEqual(['evil.io']);
    });
  });
});
