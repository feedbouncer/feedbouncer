// Render tests for what the comments page shows of each comment.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COLLAPSE_AT } from '../lib/comment-text';
import { viewOnUrl } from '../lib/permalink';
import { CommentBody } from './comment-body';
import { CommentLinks } from './comment-links';

const body = (text: string) => renderToStaticMarkup(<CommentBody body={text} />);

describe('CommentBody', () => {
  it('renders RTL, emoji, mention-only and 10k-char bodies verbatim with dir=auto and a Show more toggle', () => {
    const rtl = 'שלום עולם‏, مرحبا بالعالم';
    const emoji = '👩‍👩‍👧‍👦 🇮🇱 👍🏽';
    const mention = '@someone';
    const long = 'x'.repeat(9_990) + ' end ✓ 🙂';
    for (const text of [rtl, emoji, mention, long]) {
      const html = body(text);
      expect(html).toMatch(
        /<p dir="auto" class="whitespace-pre-wrap break-words \[overflow-wrap:anywhere\]"/,
      );
      // Every character is in the DOM, even for the collapsed one.
      expect(html).toContain(text);
    }
    expect(body(rtl)).not.toContain('Show more');
    expect(body(emoji)).not.toContain('Show more');
    expect(body(mention)).not.toContain('Show more');
    expect(body(long)).toMatch(
      /<button type="button" aria-expanded="false"[^>]*>Show more<\/button>/,
    );
  });

  it('collapses only above 600 code points', () => {
    expect(COLLAPSE_AT).toBe(600);
    expect(body('🙂'.repeat(600))).not.toContain('Show more');
    expect(body('🙂'.repeat(601))).toContain('Show more');
  });

  it('renders markup in a body as text', () => {
    const html = body('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
  });

  it('says when there is no text', () => {
    expect(body('')).toContain('(no text: sticker or attachment)');
  });
});

describe('CommentLinks', () => {
  const links = (permalink: string | null, platform = 'instagram') =>
    renderToStaticMarkup(
      <CommentLinks
        platform={platform}
        permalink={permalink}
        mediaExternalId="17900000000000009"
      />,
    );

  it('does not render a View on Instagram link for a non-https permalink', () => {
    for (const p of [
      'http://www.instagram.com/p/abc/',
      'javascript:alert(1)',
      ' https://www.instagram.com/p/abc/',
      null,
    ]) {
      const html = links(p);
      expect(html).not.toContain('View on Instagram');
      expect(html).not.toContain('<a');
      expect(html).toContain('On post 17900000000000009');
    }
  });

  it('links View on Instagram and the post for an https permalink', () => {
    const p = 'https://www.instagram.com/p/abc/';
    const html = links(p);
    expect(html).toContain(
      `<a href="${p}" rel="noopener noreferrer" target="_blank">View on Instagram</a>`,
    );
    expect(html).toContain(
      `<a href="${p}" rel="noopener noreferrer" target="_blank">On post 17900000000000009</a>`,
    );
  });

  it('uses the platform copy for Facebook', () => {
    expect(links('https://www.facebook.com/1_2', 'facebook')).toContain('View on Facebook');
  });
});

describe('viewOnUrl', () => {
  it.each([
    ['instagram', 'https://www.instagram.com/p/abc/'],
    ['instagram', 'https://instagram.com/reel/abc/'],
    ['facebook', 'https://www.facebook.com/1_2'],
  ])('accepts %s %s', (platform, url) => {
    expect(viewOnUrl(platform, url)).toBe(url);
  });
  it.each([
    ['instagram', 'https://evil.example/p/abc/'],
    ['instagram', 'https://user@www.instagram.com/p/abc/'],
    ['instagram', 'https://www.instagram.com.evil.example/'],
    ['instagram', 'https://www.facebook.com/1_2'],
    ['facebook', 'https://www.instagram.com/p/abc/'],
    ['tiktok', 'https://www.tiktok.com/x'],
  ])('rejects %s %s', (platform, url) => {
    expect(viewOnUrl(platform, url)).toBeNull();
  });
});
