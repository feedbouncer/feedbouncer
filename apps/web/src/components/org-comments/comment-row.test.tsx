import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VisibleCommentDto } from '../../lib/org-comments';
import { CommentRow } from './comment-row';

const item = (o: Partial<VisibleCommentDto> = {}): VisibleCommentDto => ({
  id: 'c1',
  brandId: 'b1',
  brandName: 'Acme',
  connectionId: 'cn1',
  connectionName: 'Acme Page',
  platform: 'facebook',
  authorName: 'Dana',
  body: 'Love it',
  postedAt: '2026-10-27T10:04:05.000Z',
  permalink: null,
  isReply: false,
  ads: [{ adId: 'a1', externalId: '123', name: 'Spring sale', deleted: false }],
  adCount: 1,
  category: 'spam',
  status: 'flagged',
  stale: false,
  ...o,
});

const render = (o?: Partial<VisibleCommentDto>) =>
  renderToStaticMarkup(<CommentRow item={item(o)} />);

describe('CommentRow', () => {
  it('renders text, author, platform + account, brand, ad, category, status and time', () => {
    const html = render();
    for (const t of [
      'Love it',
      'Dana',
      'Facebook',
      'Acme Page',
      'Acme',
      'Spring sale',
      'Spam',
      'Flagged',
    ])
      expect(html).toContain(t);
    expect(html).toContain('<time dateTime="2026-10-27T10:04:05.000Z" title=');
  });

  it('falls back for missing author, account, ad and category', () => {
    const html = render({
      authorName: null,
      connectionName: null,
      ads: [],
      adCount: 0,
      category: null,
    });
    for (const t of ['Unknown author', 'Unnamed account', 'Not on an ad', 'Uncategorized'])
      expect(html).toContain(t);
  });

  it('escapes markup in the body, keeping dir="auto"', () => {
    const html = render({ body: '<script>alert(1)</script><img src=x onerror=alert(1)> שלום 👍' });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('שלום 👍');
    expect(html).toContain('dir="auto"');
  });

  it('escapes markup in ad, account and brand names', () => {
    const html = render({
      connectionName: '<b>acct</b>',
      brandName: '<i>brand</i>',
      ads: [{ adId: 'a', externalId: '1', name: '<u>ad</u>', deleted: false }],
    });
    expect(html).not.toMatch(/<(b|i|u)>/);
    expect(html).toContain('&lt;u&gt;ad&lt;/u&gt;');
  });

  it('collapses a 5,000-character body', () => {
    expect(render({ body: 'x'.repeat(5000) })).toContain('Show more');
  });

  it('shows the stale badge and Reply only when set', () => {
    expect(render()).not.toContain('May be out of date');
    expect(render()).not.toContain('Reply');
    const html = render({ stale: true, isReply: true });
    expect(html).toContain('May be out of date');
    expect(html).toContain('Reply');
  });

  it('has no moderation buttons', () => {
    expect(render()).not.toMatch(/>(Hide|Reply|Delete|Ban)</);
    expect(render({ body: 'short' })).not.toContain('<button');
  });
});
