import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { orgNav } from '@/lib/nav';
import { AppShell, BrandSubNav } from './app-shell';
import { AuthShell } from './auth-shell';
import { StandaloneShell } from './standalone-shell';

const O = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const child = <p>child</p>;
const cases: [string, string, string][] = [
  ['AppShell', 'app', renderToStaticMarkup(<AppShell>{child}</AppShell>)],
  ['AuthShell', 'auth', renderToStaticMarkup(<AuthShell>{child}</AuthShell>)],
  [
    'StandaloneShell',
    'standalone',
    renderToStaticMarkup(<StandaloneShell>{child}</StandaloneShell>),
  ],
];

describe('shells', () => {
  it.each(cases)('%s puts the skip link first and exposes #content', (_n, shell, html) => {
    expect(html.indexOf('Skip to content')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('Skip to content')).toBeLessThan(html.indexOf('child'));
    expect(html).toContain('id="content"');
    expect(html).toContain(`data-shell="${shell}"`);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('AppShell renders the org nav and header links', () => {
    const html = renderToStaticMarkup(<AppShell nav={orgNav(O)}>{child}</AppShell>);
    expect(html).toContain('aria-label="Organization"');
    expect(html).toContain('href="/hidden-today"');
    expect(html).toContain('href="/account"');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('BrandSubNav renders the brand nav', () => {
    const html = renderToStaticMarkup(<BrandSubNav orgId={O} brandId={B} />);
    expect(html).toContain('aria-label="Brand"');
    expect(html).not.toMatch(/https?:\/\//);
  });
});
