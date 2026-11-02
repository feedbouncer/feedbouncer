import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import RootError from './error';
import OrgError from './orgs/[orgId]/error';
import NotFound from './not-found';
import OrgLayout from './orgs/[orgId]/layout';

const boom = Object.assign(new Error('db password=hunter2'), { digest: 'abc' });

describe.each([
  ['root error', RootError],
  ['org error', OrgError],
])('%s', (_n, Page) => {
  it('shows generic copy and the digest, never the message', () => {
    const html = renderToStaticMarkup(<Page error={boom} reset={() => {}} />);
    expect(html).toContain('Something went wrong');
    expect(html).toContain('abc');
    expect(html).not.toContain('hunter2');
  });

  it('omits the reference without a digest', () => {
    const html = renderToStaticMarkup(
      <Page error={new Error('db password=hunter2')} reset={() => {}} />,
    );
    expect(html).not.toContain('Reference:');
    expect(html).not.toContain('hunter2');
  });
});

describe('NotFound', () => {
  it('renders friendly copy and a way home', () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain('Page not found');
    expect(html).toContain('href="/"');
    expect(html).toContain('<main');
  });
});

describe('OrgLayout', () => {
  it('404s on a non-uuid org id', async () => {
    await expect(
      OrgLayout({ children: null, params: Promise.resolve({ orgId: 'nope' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
