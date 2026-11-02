import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { orgNav } from '../../lib/nav';
import { AppShell } from './app-shell';
import { AuthShell } from './auth-shell';
import { StandaloneShell } from './standalone-shell';

const O = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const path = vi.hoisted(() => ({ current: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => path.current }));

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
  it.each(cases)(
    '%s exposes #content and leaves the skip link to the root layout',
    (_n, shell, html) => {
      expect(html).not.toContain('Skip to content');
      expect(html).toContain('id="content"');
      expect(html).toContain(`data-shell="${shell}"`);
      expect(html).not.toMatch(/https?:\/\//);
    },
  );

  it('AppShell renders the org nav and header links', () => {
    const html = renderToStaticMarkup(<AppShell nav={orgNav(O)}>{child}</AppShell>);
    expect(html).toContain('aria-label="Organization"');
    expect(html).toContain('href="/hidden-today"');
    expect(html).toContain('href="/account"');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('AppShell shows the brand nav in the header on brand pages only', () => {
    path.current = `/orgs/${O}/brands/${B}/rules`;
    const onBrand = renderToStaticMarkup(<AppShell nav={orgNav(O)}>{child}</AppShell>);
    expect(onBrand.indexOf('aria-label="Brand"')).toBeLessThan(onBrand.indexOf('id="content"'));
    path.current = `/orgs/${O}/comments`;
    expect(renderToStaticMarkup(<AppShell nav={orgNav(O)}>{child}</AppShell>)).not.toContain(
      'aria-label="Brand"',
    );
    path.current = '/orgs/not-a-uuid/brands/also-bad/rules';
    expect(renderToStaticMarkup(<AppShell nav={orgNav(O)}>{child}</AppShell>)).not.toContain(
      'aria-label="Brand"',
    );
  });
});
