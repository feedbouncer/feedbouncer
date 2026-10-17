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
  done: null,
  tags: [],
  replies: [],
  replyCount: 0,
  reply: { available: true, maxChars: 8000 },
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

  it('done badge, tags and replies render; reply text with <script> and RTL escaped with dir="auto"', () => {
    const html = render({
      done: { at: '2026-10-27T11:00:00.000Z', byName: 'Noa' },
      tags: [
        { id: 't1', name: 'Urgent' },
        { id: 't2', name: '🔥' },
      ],
      replies: [
        {
          id: 'r1',
          text: '<script>alert(1)</script> תודה רבה',
          status: 'applied',
          actorType: 'user',
          authorName: 'Noa',
          createdAt: '2026-10-27T11:05:00.000Z',
          completedAt: '2026-10-27T11:05:02.000Z',
        },
        {
          id: 'r2',
          text: 'On its way',
          status: 'pending',
          actorType: 'user',
          authorName: null,
          createdAt: '2026-10-27T11:06:00.000Z',
          completedAt: null,
        },
        {
          id: 'r3',
          text: 'Auto thanks',
          status: 'applied',
          actorType: 'rule',
          authorName: null,
          createdAt: '2026-10-27T11:07:00.000Z',
          completedAt: null,
        },
      ],
      replyCount: 3,
    });
    expect(html).toContain('title="Marked done by Noa 2026-10-27 11:00 UTC">Done</span>');
    expect(html).toContain('Tags');
    expect(html).toContain('>Urgent</li>');
    expect(html).toContain('>🔥</li>');
    expect(html).toContain('Noa replied · <time dateTime="2026-10-27T11:05:00.000Z"');
    expect(html).toContain('A teammate replied');
    expect(html).toContain('Automation replied');
    expect(html).toContain('Sending…');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; תודה רבה');
    const at = html.indexOf('&lt;script&gt;alert(1)');
    expect(html.slice(html.lastIndexOf('<p', at), at)).toContain('dir="auto"');
  });

  it('done badge falls back to a teammate; no badge, tags or replies when empty', () => {
    expect(render({ done: { at: '2026-10-27T11:00:00.000Z', byName: null } })).toContain(
      'title="Marked done by a teammate 2026-10-27 11:00 UTC">Done</span>',
    );
    const html = render();
    expect(html).not.toContain('>Done<');
    expect(html).not.toContain('Tags');
    expect(html).not.toContain('replied');
  });

  it('tag names with markup escaped', () => {
    const html = render({ tags: [{ id: 't', name: '<img src=x onerror=alert(1)>' }] });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders the slots: selection, triage in place of read-only tags, and actions', () => {
    const html = renderToStaticMarkup(
      <CommentRow
        item={item({ tags: [{ id: 't', name: 'ReadOnlyTag' }] })}
        select={<input type="checkbox" aria-label="Select" />}
        triage={<div>TRIAGE</div>}
      >
        <div>ACTIONS</div>
      </CommentRow>,
    );
    expect(html).toContain('aria-label="Select"');
    expect(html).toContain('TRIAGE');
    expect(html).toContain('ACTIONS');
    expect(html).not.toContain('ReadOnlyTag');
  });

  it('has no moderation buttons', () => {
    expect(render()).not.toMatch(/>(Hide|Reply|Delete|Ban)</);
    expect(render({ body: 'short' })).not.toContain('<button');
  });
});
