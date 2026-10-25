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
      expect(html).toMatch(/<p dir="auto" style="white-space:pre-wrap;overflow-wrap:anywhere/);
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

  it('links only View on Instagram for an https permalink; the post id is plain text', () => {
    const p = 'https://www.instagram.com/p/abc/';
    const html = links(p);
    expect(html).toContain(
      `<a href="${p}" rel="noopener noreferrer" target="_blank">View on Instagram</a>`,
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('<span>On post 17900000000000009</span>');
  });

  it('uses the platform copy for Facebook', () => {
    expect(links('https://www.facebook.com/1_2', 'facebook')).toContain('View on Facebook');
  });

  const tiktok = (platform: string, sourcePermalink: string | null, id: string) =>
    renderToStaticMarkup(
      <CommentLinks
        platform={platform}
        permalink={null}
        mediaExternalId={id}
        sourcePermalink={sourcePermalink}
      />,
    );

  it('links a TikTok comment to its video', () => {
    const v = 'https://www.tiktok.com/@shop/video/7300000000000000301';
    const html = tiktok('tiktok', v, '7300000000000000301');
    expect(html).toContain('<span>On video 7300000000000000301</span>');
    expect(html).toContain(
      `<a href="${v}" rel="noopener noreferrer" target="_blank">View on TikTok</a>`,
    );
  });

  it('names the ad and links its video; without a usable link only the ad id shows', () => {
    const v = 'https://www.tiktok.com/@/video/7300000000000000302';
    const html = tiktok('tiktok_ads', v, '1800000000000000001');
    expect(html).toContain('<span>Ad 1800000000000000001</span>');
    expect(html).toContain(
      `<a href="${v}" rel="noopener noreferrer" target="_blank">Video 7300000000000000302</a>`,
    );
    for (const bad of [null, 'https://evil.example/@/video/7300000000000000302']) {
      const plain = tiktok('tiktok_ads', bad, '1800000000000000001');
      expect(plain).not.toContain('<a');
      expect(plain).toContain('Ad 1800000000000000001');
    }
    const named = tiktok('tiktok_ads', 'https://www.tiktok.com/@shop/video/1', '18');
    expect(named).toContain('>Video 1</a>');
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
    ['threads', 'https://www.threads.net/x'],
    ['youtube', 'https://www.youtube.com.evil.example/x'],
  ])('rejects %s %s', (platform, url) => {
    expect(viewOnUrl(platform, url)).toBeNull();
  });
});
