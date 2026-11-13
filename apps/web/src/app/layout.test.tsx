import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./fonts', () => ({ display: { variable: 'fd' }, body: { variable: 'fb' } }));
vi.mock('../components/beta-notice', () => ({ BetaNotice: () => <aside>beta notice</aside> }));
vi.mock('./globals.css', () => ({}));
// The provider infers locale and messages from the Next request config, which does not exist here.
vi.mock('next-intl', () => ({
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import RootLayout from './layout';

describe('RootLayout', () => {
  it('renders an html element with font variables and its children', () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <main>hello</main>
      </RootLayout>,
    );
    const tag = /<html[^>]*>/.exec(html)?.[0] ?? '';
    expect(tag).toMatch(/class="[^"]*\bfd\b/);
    expect(tag).toMatch(/class="[^"]*\bfb\b/);
    expect(tag).toContain('lang="en"');
    expect(html).toContain('<main>hello</main>');
  });

  it('renders the skip link before the beta notice and the content', () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <main>hello</main>
      </RootLayout>,
    );
    const skip = html.indexOf('Skip to content');
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(skip).toBeLessThan(html.indexOf('beta notice'));
    expect(skip).toBeLessThan(html.indexOf('hello'));
  });
});
