import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UnsubscribePage from './page';

const TOKEN = 'A'.repeat(43);
const render = async (token: string | string[] | undefined) =>
  renderToStaticMarkup(await UnsubscribePage({ searchParams: Promise.resolve({ token }) }));

afterEach(() => vi.restoreAllMocks());

describe('report unsubscribe page', () => {
  it('invalid token shows the error state and makes no request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const token of [undefined, 'short', `${TOKEN}=`, [TOKEN, TOKEN]]) {
      const html = await render(token);
      expect(html).toContain(
        'This link is invalid. Manage weekly report emails in your account settings.',
      );
      expect(html).toContain('href="/account#email-reports"');
      expect(html).not.toContain('<form');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a valid token renders a button and sends nothing until it is pressed', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const html = await render(TOKEN);
    expect(html).toMatch(/<form[^>]*method="post"/i);
    expect(html).toContain(`action="/api/v1/report-subscriptions/unsubscribe?token=${TOKEN}"`);
    expect(html).toContain('name="List-Unsubscribe" value="One-Click"');
    expect(html).toMatch(/<button type="submit"[^>]*>Unsubscribe<\/button>/);
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/\.submit\(|requestSubmit/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
