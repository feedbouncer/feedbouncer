import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withIntl } from '../../../test/intl';

vi.mock('next-intl/server', async () => (await import('../../../test/intl')).mockServerIntl());
vi.mock('server-only', () => ({}));

const OID = '123e4567-e89b-42d3-a456-426614174000';
const serverGet = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
  notFound: () => {
    throw new Error('NOTFOUND');
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../../lib/server-api', async () => ({
  serverGet: (p: string) => serverGet(p),
  requireMe: vi.fn(async () => ({})),
  dataOrThrow: (r: { data: unknown }) => r.data,
}));

import Page from './page';

const onboarding = (over: object = {}) => ({
  started: true,
  autoStart: false,
  preconfigured: false,
  dismissed: false,
  complete: false,
  resumeStep: 'defaults',
  ...over,
});

const answer = (role: string, s: object = onboarding()) =>
  serverGet.mockImplementation(async (p: string) => {
    if (p.endsWith('/onboarding')) return { status: 200, data: s };
    if (p.endsWith('/brands')) return { status: 200, data: { brands: [] } };
    return {
      status: 200,
      data: {
        role,
        organization: { id: OID, name: 'Acme', timezone: 'UTC', timezoneSet: true },
      },
    };
  });
const run = () => Page({ params: Promise.resolve({ orgId: OID }) });

beforeEach(() => {
  serverGet.mockReset();
  redirect.mockClear();
});

describe('org overview', () => {
  it('redirects on autoStart; shows Run setup again when complete', async () => {
    answer('owner', onboarding({ autoStart: true, started: false }));
    await expect(run()).rejects.toThrow(`REDIRECT:/orgs/${OID}/onboarding`);

    answer('owner', onboarding({ complete: true }));
    const html = renderToStaticMarkup(withIntl(await run()));
    expect(html).toContain('Setup wizard');
    expect(html).toContain('Run setup again');
    expect(html).not.toContain('Continue setup');
  });

  it('shows Continue setup when started and not complete', async () => {
    answer('admin');
    const html = renderToStaticMarkup(withIntl(await run()));
    expect(html).toContain(`href="/orgs/${OID}/onboarding"`);
    expect(html).toContain('Continue setup');
    expect(html).not.toContain('Run setup again');
  });

  it('never redirects or shows the card for members, and never redirects preconfigured orgs', async () => {
    answer('member', onboarding({ autoStart: true }));
    const html = renderToStaticMarkup(withIntl(await run()));
    expect(redirect).not.toHaveBeenCalled();
    expect(html).not.toContain('Setup wizard');
    expect(serverGet).not.toHaveBeenCalledWith(expect.stringMatching(/onboarding$/));

    answer('owner', onboarding({ autoStart: false, preconfigured: true, started: false }));
    await run();
    expect(redirect).not.toHaveBeenCalled();
  });
});
