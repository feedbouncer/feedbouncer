import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withIntl } from '../../../../../test/intl';

vi.mock('next-intl/server', async () =>
  (await import('../../../../../test/intl')).mockServerIntl(),
);

vi.mock('server-only', () => ({}));

const OID = '123e4567-e89b-42d3-a456-426614174000';
const serverGet = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
const notFound = vi.fn(() => {
  throw new Error('NOTFOUND');
});
vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
  notFound: () => notFound(),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('../../../../../lib/server-api', async () => ({
  serverGet: (p: string) => serverGet(p),
  requireMe: vi.fn(async () => ({})),
  dataOrThrow: (r: { data: unknown }) => r.data,
}));

import Page from './page';

const state = (over: object = {}) => ({
  started: true,
  autoStart: false,
  preconfigured: false,
  dismissed: false,
  complete: false,
  run: 1,
  steps: { connect: 'pending', defaults: 'pending', review_mode: 'pending', report: 'pending' },
  resumeStep: 'connect',
  reachable: { connect: true, defaults: false, review_mode: false, report: false },
  brand: null,
  brands: [],
  configuredPlatforms: [],
  connections: [],
  reviewModeChoice: null,
  ...over,
});

const answer = (role: string, s = state()) =>
  serverGet.mockImplementation(async (p: string) =>
    p.endsWith('/onboarding') ? { status: 200, data: s } : { status: 200, data: { role } },
  );
const run = (step: string, orgId = OID) => Page({ params: Promise.resolve({ orgId, step }) });

beforeEach(() => {
  serverGet.mockReset();
  redirect.mockClear();
  notFound.mockClear();
});

describe('onboarding step page', () => {
  it('redirects an unreachable step to the resume step', async () => {
    answer('owner');
    await expect(run('report')).rejects.toThrow(`REDIRECT:/orgs/${OID}/onboarding/connect`);
    expect(redirect).toHaveBeenCalledWith(`/orgs/${OID}/onboarding/connect`);
  });

  it('an unreachable step that is also the resume step is notFound, not a redirect loop', async () => {
    answer(
      'owner',
      state({
        resumeStep: null,
        reachable: { connect: false, defaults: false, review_mode: false, report: false },
      }),
    );
    await expect(run('report')).rejects.toThrow('NOTFOUND');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('unknown step or bad org id is notFound', async () => {
    answer('owner');
    await expect(run('nope')).rejects.toThrow('NOTFOUND');
    await expect(run('connect', 'x')).rejects.toThrow('NOTFOUND');
  });

  it('a member sees only the notAllowed text and no form', async () => {
    answer('member');
    const html = renderToStaticMarkup(withIntl(await run('connect')));
    expect(html).toContain('Only owners and admins can set up this workspace.');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(serverGet).not.toHaveBeenCalledWith(expect.stringMatching(/onboarding$/));
  });

  it('renders the frame and placeholder for a reachable step', async () => {
    answer('admin');
    const html = renderToStaticMarkup(withIntl(await run('connect')));
    expect(html).toContain('Step 1 of 4');
    expect(html).toContain('Skip setup for now');
    expect(html).toContain('Connect your social accounts here.');
  });
});
