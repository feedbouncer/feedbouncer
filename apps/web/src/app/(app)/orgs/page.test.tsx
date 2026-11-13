import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const OID = '123e4567-e89b-42d3-a456-426614174000';
const serverGet = vi.fn();
const requireMe = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../../lib/server-api', async () => ({
  serverGet: (p: string) => serverGet(p),
  requireMe: (p: string) => requireMe(p),
  dataOrThrow: (r: { data: unknown }) => r.data,
}));

import Page from './page';

const me = (memberships: object[]) => ({
  user: { id: 'u', email: 'a@b.c', name: null, emailVerified: true },
  memberships,
});
const membership = (over: object = {}) => ({
  organizationId: OID,
  organizationName: 'Acme',
  role: 'owner',
  organizationStatus: 'active',
  ...over,
});
const run = () => Page({ searchParams: Promise.resolve({}) });
const onboarding = (autoStart: boolean) =>
  serverGet.mockResolvedValue({ status: 200, data: { autoStart } });

beforeEach(() => {
  serverGet.mockReset();
  requireMe.mockReset();
  redirect.mockClear();
});

describe('/orgs', () => {
  it('redirects a single-membership manager whose org autoStarts', async () => {
    requireMe.mockResolvedValue(me([membership()]));
    onboarding(true);
    await expect(run()).rejects.toThrow(`REDIRECT:/orgs/${OID}/onboarding`);
  });

  it('does not redirect members, preconfigured orgs, several memberships or suspended orgs', async () => {
    requireMe.mockResolvedValue(me([membership({ role: 'member' })]));
    onboarding(true);
    renderToStaticMarkup(await run());
    expect(serverGet).not.toHaveBeenCalled();

    requireMe.mockResolvedValue(me([membership()]));
    onboarding(false);
    renderToStaticMarkup(await run());

    requireMe.mockResolvedValue(me([membership(), membership({ organizationId: 'x' })]));
    onboarding(true);
    renderToStaticMarkup(await run());

    requireMe.mockResolvedValue(me([membership({ organizationStatus: 'suspended' })]));
    renderToStaticMarkup(await run());
    expect(redirect).not.toHaveBeenCalled();
  });
});
