import { describe, expect, it } from 'vitest';
import { excerpt, slackEscape } from './excerpt.js';

const slack = (s: string) => slackEscape(excerpt(s));

describe('excerpt', () => {
  it('excerpt sanitizes mentions, markup, links, bidi and length', () => {
    expect(slack('<!channel> look')).toContain('&lt;!channel&gt;');
    expect(slack('<!channel> look')).not.toContain('<!channel>');
    expect(slack('@here buy')).toBe('@​here buy');
    expect(slack('@channel and @Everyone')).toBe('@​channel and @​Everyone');
    expect(slack('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(slack('a & b')).toBe('a &amp; b');
    expect(excerpt('visit https://evil.io/x now')).toBe('visit [link] now');
    expect(excerpt('see www.evil.io/path, or HTTP://X.IO')).toBe('see [link] or [link]');
    expect(excerpt('‮abc')).toBe('abc');
    expect(excerpt('a‎b⁦c⁩d')).toBe('a b c d');
    const long = excerpt('🔥'.repeat(5000));
    expect(Array.from(long)).toHaveLength(141);
    expect(long.endsWith('…')).toBe(true);
    expect(Array.from(long.slice(0, -1)).every((c) => c === '🔥')).toBe(true);
    expect(excerpt('one\r\ntwo\t\tthree   four')).toBe('one two three four');
  });

  it('leaves short text untruncated', () => {
    const s = 'x'.repeat(140);
    expect(excerpt(s)).toBe(s);
  });
});
