import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serverGet = vi.fn();
vi.mock('../lib/server-api', () => ({ serverGet: (p: string) => serverGet(p) }));
vi.mock('../lib/api-url', () => ({ apiInternalUrl: () => null }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('../components/shell/standalone-shell', () => ({
  StandaloneShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import Home from './page';

const render = async () => renderToStaticMarkup(await Home());
const answer = (enabled: boolean) =>
  serverGet.mockImplementation(async (path: string) =>
    path === '/api/v1/me' ? { status: 401, data: null } : { status: 200, data: { enabled } },
  );

beforeEach(() => {
  serverGet.mockReset();
});

describe('home page', () => {
  it('enabled: offers Sign up and Log in', async () => {
    answer(true);
    const html = await render();
    expect(html).toContain('href="/sign-up"');
    expect(html).toContain('Log in');
  });

  it('disabled: hides Sign up and keeps Log in', async () => {
    answer(false);
    const html = await render();
    expect(html).not.toContain('href="/sign-up"');
    expect(html).toContain('Log in');
  });
});
