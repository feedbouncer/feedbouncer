import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleResult } from './_components/fixtures';

const serverGet = vi.fn();
vi.mock('../../lib/server-api', () => ({ serverGet: (p: string) => serverGet(p) }));
vi.mock('./_components/connect-button', () => ({ ConnectButton: () => <button>Connect</button> }));
vi.mock('./_components/delete-data-button', () => ({
  DeleteDataButton: () => <button>Del</button>,
}));

import ScanPage from './page';

const render = async (sp: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await ScanPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  serverGet.mockReset();
  serverGet.mockResolvedValue({ status: 200, data: { scans: [] } });
});

describe('scan landing page', () => {
  it('error banner shows known codes and ignores unknown ones', async () => {
    expect(await render({ error: 'declined' })).toContain('role="alert"');
    const bad = await render({ error: '<img>' });
    expect(bad).not.toContain('role="alert"');
    expect(bad).not.toContain('<img');
  });

  it('missing permissions lists only known purposes', async () => {
    const html = await render({ error: 'missing_permissions', missing: 'ads_read,evil' });
    expect(html).toContain('Read your ads');
    expect(html).not.toContain('evil');
  });

  it('lists previous scans with links', async () => {
    serverGet.mockResolvedValue({
      status: 200,
      data: {
        scans: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            status: 'completed',
            failureReason: null,
            pageName: 'Acme',
            createdAt: '2026-10-01T00:00:00Z',
            finishedAt: '2026-10-01T00:01:00Z',
            shared: false,
            result: sampleResult(),
          },
        ],
      },
    });
    const html = await render();
    expect(html).toContain('href="/scan/results/11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('Acme');
    expect(html).toContain('Del');
  });

  it('does not break when the list is unavailable', async () => {
    serverGet.mockResolvedValue({ status: 404, data: null });
    expect(await render()).toContain('Connect');
  });
});
