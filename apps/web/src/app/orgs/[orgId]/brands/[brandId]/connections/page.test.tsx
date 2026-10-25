import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectionsPage from './page';

const ORG = '00000000-0000-4000-8000-000000000001';
const BRAND = '00000000-0000-4000-8000-000000000002';
const TT = '00000000-0000-4000-8000-000000000003';
const YT = '00000000-0000-4000-8000-000000000004';

const responses = new Map<string, unknown>();

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  unstable_rethrow: () => undefined,
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
vi.mock('../../../../../../lib/server-api', () => ({
  requireMe: async () => ({ id: 'u1' }),
  loadReviewMode: async () => ({ connections: [], pendingTotal: 0, canManage: true }),
  serverGet: async (path: string) => ({ status: 200, data: responses.get(path) ?? null }),
  dataOrThrow: <T,>(r: { data: T | null }) => {
    if (!r.data) throw new Error('missing');
    return r.data;
  },
}));

const base = `/api/v1/orgs/${ORG}/brands/${BRAND}/connections`;
const render = async () =>
  renderToStaticMarkup(
    await ConnectionsPage({
      params: Promise.resolve({ orgId: ORG, brandId: BRAND }),
      searchParams: Promise.resolve({}),
    }),
  );

beforeEach(() => {
  responses.clear();
  responses.set(`/api/v1/orgs/${ORG}`, { role: 'owner' });
  responses.set(base, { connections: [] });
  responses.set(`${base}/health`, { connections: [] });
});

describe('connections page', () => {
  it('renders both TikTok connect buttons', async () => {
    const html = await render();
    expect(html).toContain('>Connect TikTok account</button>');
    expect(html).toContain('>Connect TikTok ads</button>');
  });

  it('labels a TikTok connection and names the permission it is missing', async () => {
    responses.set(base, {
      connections: [
        {
          id: TT,
          platform: 'tiktok',
          displayName: 'shop.tt',
          status: 'needs_reconnect',
          statusReason: 'oauth_scope_missing',
          backfill: null,
        },
      ],
    });
    responses.set(`${base}/health`, {
      connections: [
        {
          connectionId: TT,
          platform: 'tiktok',
          status: 'needs_reconnection',
          reason: 'oauth_scope_missing',
          lastErrorCode: null,
          ingestLagSeconds: 0,
          failedImports: 0,
          missingScopes: ['comment.list', '<script>'],
        },
      ],
    });
    const html = await render();
    expect(html).toContain('<td>TikTok account</td>');
    expect(html).toContain(
      'Missing permission: comment.list. Reconnect and approve all requested permissions.',
    );
    expect(html).not.toContain('<script');
    expect(html).toContain('>Reconnect</button>');
  });

  it('lists YouTube as connectable', async () => {
    const html = await render();
    expect(html).toContain('>Connect YouTube channel</button>');
  });

  it('shows the quota budget panel under a YouTube connection only', async () => {
    responses.set(base, {
      connections: [
        {
          id: YT,
          platform: 'youtube',
          displayName: 'My channel',
          status: 'connected',
          statusReason: null,
          backfill: null,
        },
        {
          id: TT,
          platform: 'tiktok',
          displayName: 'shop.tt',
          status: 'connected',
          statusReason: null,
          backfill: null,
        },
      ],
    });
    const html = await render();
    expect(html).toContain('<td>YouTube channel</td>');
    expect(html.match(/Loading YouTube budget/g)).toHaveLength(1);
    expect(html).toContain('My channel');
  });
});
