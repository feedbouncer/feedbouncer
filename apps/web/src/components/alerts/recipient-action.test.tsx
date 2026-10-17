import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ConfirmPage from '../../app/alerts/confirm/page';
import UnsubscribePage from '../../app/alerts/unsubscribe/page';
import { RecipientAction } from './recipient-action';

const TOKEN = 'A'.repeat(43);

describe('public recipient pages', () => {
  it('confirm/unsubscribe pages render a POST form and no auto-submit script', async () => {
    for (const [page, label, action] of [
      [ConfirmPage, 'Confirm alerts', '/api/v1/alert-recipients/confirm'],
      [UnsubscribePage, 'Unsubscribe', `/api/v1/alert-recipients/unsubscribe?token=${TOKEN}`],
    ] as const) {
      const html = renderToStaticMarkup(
        await page({ searchParams: Promise.resolve({ token: TOKEN }) }),
      );
      expect(html).toMatch(/<form[^>]*method="post"/i);
      expect(html).toContain(`action="${action}"`);
      expect(html).toContain(label);
      expect(html).not.toContain('<script');
      expect(html).not.toMatch(/\.submit\(|requestSubmit/);
    }
  });

  it('shows the invalid message and no form for a missing or malformed token', async () => {
    for (const token of [undefined, 'short', ['a', 'b']]) {
      const c = renderToStaticMarkup(
        await ConfirmPage({ searchParams: Promise.resolve({ token }) }),
      );
      expect(c).toContain(
        'This confirmation link is invalid or has expired. Ask a workspace admin to resend it.',
      );
      expect(c).not.toContain('<form');
      const u = renderToStaticMarkup(
        await UnsubscribePage({ searchParams: Promise.resolve({ token }) }),
      );
      expect(u).toContain('This link is invalid. Manage alerts in FeedBouncer.');
      expect(u).not.toContain('<form');
    }
  });

  it('unsubscribe form carries the one-click field for the no-script fallback', () => {
    const html = renderToStaticMarkup(<RecipientAction kind="unsubscribe" token={TOKEN} />);
    expect(html).toContain('name="List-Unsubscribe"');
    expect(html).toContain('value="One-Click"');
  });
});
