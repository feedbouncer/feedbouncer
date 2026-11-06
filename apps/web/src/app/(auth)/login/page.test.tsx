import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serverGet = vi.fn();
vi.mock('../../../lib/server-api', () => ({ serverGet: (p: string) => serverGet(p) }));
vi.mock('../../../components/api-form', () => ({
  ApiForm: () => <form>login form</form>,
}));

import LoginPage from './page';

const VALID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const render = async (sp: { next?: string } = {}) =>
  renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(sp) }));
const setEnabled = (enabled: boolean) =>
  serverGet.mockResolvedValue({ status: 200, data: { enabled } });

beforeEach(() => {
  serverGet.mockReset();
});

describe('login page', () => {
  it('enabled: shows the Create an account link to /sign-up', async () => {
    setEnabled(true);
    const html = await render();
    expect(html).toContain('href="/sign-up"');
    expect(html).toContain('Create an account');
  });

  it('disabled: hides the Create an account link and keeps the form and the forgot-password link', async () => {
    setEnabled(false);
    const html = await render();
    expect(html).not.toContain('href="/sign-up');
    expect(html).not.toContain('Create an account');
    expect(html).toContain('login form');
    expect(html).toContain('href="/forgot-password"');
  });

  it('disabled with next=/invite?token=<valid>: links to /sign-up?invitation=<valid>', async () => {
    setEnabled(false);
    const html = await render({ next: `/invite?token=${VALID}` });
    expect(html).toContain(`href="/sign-up?invitation=${VALID}"`);
  });

  it('disabled with a malformed invitation in next: no sign-up link', async () => {
    setEnabled(false);
    const html = await render({ next: '/invite?token=<img>' });
    expect(html).not.toContain('href="/sign-up');
    expect(html).not.toContain('<img');
  });
});
