import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SelectAccountsPage from './page';

const ORG = '00000000-0000-4000-8000-000000000001';
const BRAND = '00000000-0000-4000-8000-000000000002';
const GRANT = '00000000-0000-4000-8000-000000000003';
const OTHER = '00000000-0000-4000-8000-000000000009';

let cookieValue: string | undefined;
let eligible = true;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'fb_onboarding_return' && cookieValue !== undefined
        ? { name, value: cookieValue }
        : undefined,
  }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock('../../../../../../../../lib/server-api', () => ({
  requireMe: async () => ({ id: 'u1' }),
  serverGet: async () => ({
    status: 200,
    data: {
      accounts: [
        {
          externalAccountId: '17841400000000001',
          displayName: '@shop',
          eligible,
          ineligibleReason: eligible ? null : 'no_linked_instagram_account',
          limitations: [],
          connection: null,
        },
      ],
    },
  }),
}));

const render = async () =>
  renderToStaticMarkup(
    await SelectAccountsPage({
      params: Promise.resolve({ orgId: ORG, brandId: BRAND, platform: 'instagram' }),
      searchParams: Promise.resolve({ grant: GRANT }),
    }),
  );

beforeEach(() => {
  cookieValue = undefined;
  eligible = true;
});

describe('select page', () => {
  it('with a matching cookie is in wizard mode', async () => {
    cookieValue = ORG;
    expect(await render()).not.toContain('name="reviewMode"');
    eligible = false;
    expect(await render()).toContain(`href="/orgs/${ORG}/onboarding/connect"`);
  });

  it.each([undefined, OTHER, 'not-an-org'])('with cookie %s behaves as before', async (value) => {
    cookieValue = value;
    expect(await render()).toContain('name="reviewMode"');
    eligible = false;
    const html = await render();
    expect(html).toContain(`href="/orgs/${ORG}/brands/${BRAND}/connections"`);
    expect(html).not.toContain('/onboarding/');
  });
});
