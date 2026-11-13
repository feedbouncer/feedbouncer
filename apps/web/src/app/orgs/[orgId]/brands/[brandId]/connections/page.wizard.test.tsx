import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectionsPage from './page';

const ORG = '00000000-0000-4000-8000-000000000001';
const BRAND = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000009';

let cookieValue: string | undefined;

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

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
  redirect: (to: string) => {
    throw new Redirected(to);
  },
  unstable_rethrow: (e: unknown) => {
    if (e instanceof Redirected) throw e;
  },
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock('../../../../../../lib/server-api', () => ({
  requireMe: async () => ({ id: 'u1' }),
  loadReviewMode: async () => ({ connections: [], pendingTotal: 0, canManage: true }),
  serverGet: async (path: string) => ({
    status: 200,
    data: path.endsWith('/connections')
      ? { connections: [] }
      : path.endsWith('/health')
        ? { connections: [] }
        : { role: 'owner' },
  }),
  dataOrThrow: <T,>(r: { data: T | null }) => r.data as T,
}));

const run = async (error?: string) => {
  try {
    return renderToStaticMarkup(
      await ConnectionsPage({
        params: Promise.resolve({ orgId: ORG, brandId: BRAND }),
        searchParams: Promise.resolve(error === undefined ? {} : { error }),
      }),
    );
  } catch (e) {
    if (e instanceof Redirected) return e.to;
    throw e;
  }
};

beforeEach(() => {
  cookieValue = undefined;
});

describe('connections page in wizard mode', () => {
  const home = `/orgs/${ORG}/onboarding/connect`;

  it('renders the normal page for a visit without an OAuth result', async () => {
    cookieValue = ORG;
    expect(await run()).toContain('Connect a platform');
  });

  it('forwards a safe error code', async () => {
    cookieValue = ORG;
    expect(await run('denied')).toBe(`${home}?error=denied`);
  });

  it('drops an unsafe error code', async () => {
    cookieValue = ORG;
    expect(await run('<script>')).toBe(home);
  });

  it.each([undefined, OTHER])('with cookie %s renders the normal page', async (value) => {
    cookieValue = value;
    expect(await run('denied')).toContain('Connect a platform');
  });
});
