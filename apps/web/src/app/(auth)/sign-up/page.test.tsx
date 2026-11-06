import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNUP_DISABLED_TEXT } from '../../../lib/signup';

const serverGet = vi.fn();
vi.mock('../../../lib/server-api', () => ({ serverGet: (p: string) => serverGet(p) }));
const formProps = vi.fn();
vi.mock('../../../components/api-form', () => ({
  ApiForm: (props: { submitLabel: string }) => {
    formProps(props);
    return (
      <form>
        <input type="password" />
        <button>{props.submitLabel}</button>
      </form>
    );
  },
}));

import SignUpPage from './page';

const VALID = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const render = async (sp: { invitation?: string | string[] } = {}) =>
  renderToStaticMarkup(await SignUpPage({ searchParams: Promise.resolve(sp) }));
const setEnabled = (enabled: boolean) =>
  serverGet.mockResolvedValue({ status: 200, data: { enabled } });

beforeEach(() => {
  serverGet.mockReset();
  formProps.mockReset();
});

describe('sign-up page', () => {
  it('enabled: renders the existing form unchanged', async () => {
    setEnabled(true);
    const html = await render();
    expect(html).toContain('Create your account');
    expect(html).toContain('Sign up');
    expect(html).not.toContain(SIGNUP_DISABLED_TEXT);
    expect(formProps.mock.calls[0]![0].extraBody).toBeUndefined();
  });

  it('disabled: direct visit shows the message instead of a form', async () => {
    setEnabled(false);
    const html = await render();
    expect(html).toContain(SIGNUP_DISABLED_TEXT);
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('type="password"');
  });

  it('disabled with a valid ?invitation= renders the form and sends invitationToken', async () => {
    setEnabled(false);
    const html = await render({ invitation: VALID });
    expect(html).toContain('<form');
    expect(html).not.toContain(SIGNUP_DISABLED_TEXT);
    expect(formProps.mock.calls[0]![0].extraBody).toEqual({ invitationToken: VALID });
  });

  it('ignores malformed invitation tokens', async () => {
    setEnabled(false);
    const html = await render({ invitation: '<img src=x>' });
    expect(html).toContain(SIGNUP_DISABLED_TEXT);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<form');
  });

  it('sign-up page renders the form when availability cannot be read', async () => {
    serverGet.mockImplementation(() => {
      throw new Error('down');
    });
    const html = await render();
    expect(html).toContain('<form');
  });
});
