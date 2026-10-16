import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TimezoneNotice } from './timezone-notice';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const render = (canManage: boolean) =>
  renderToStaticMarkup(
    <TimezoneNotice orgId="o" brandId="b" brandName="Shop" canManage={canManage} />,
  );

describe('TimezoneNotice', () => {
  it('managers get a Use button for the browser timezone', () => {
    const html = render(true);
    expect(html).toContain(
      '&quot;Today&quot; for Shop uses UTC midnight. Set this brand&#x27;s timezone',
    );
    expect(html).toMatch(/<button[^>]*>Use [^<]+<\/button>/);
    expect(html).not.toContain('Ask an admin');
  });

  it('members are told to ask an admin', () => {
    const html = render(false);
    expect(html).toContain('Ask an admin to set it.');
    expect(html).not.toContain('<button');
  });
});
