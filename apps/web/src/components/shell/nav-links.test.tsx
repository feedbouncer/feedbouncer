import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { orgNav } from '@/lib/nav';
import { NavLinks } from './nav-links';

const O = '11111111-1111-4111-8111-111111111111';

vi.mock('next/navigation', () => ({ usePathname: () => `/orgs/${O}/comments` }));

describe('NavLinks', () => {
  it('marks exactly the current link with aria-current', () => {
    const html = renderToStaticMarkup(<NavLinks items={orgNav(O)} label="Organization" />);
    expect(html).toContain('aria-label="Organization"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Comments<\/a>/);
  });
});
