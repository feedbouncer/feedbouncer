import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ReplyGrantToggle } from './reply-grant-toggle';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const render = (granted: boolean, canChange: boolean): string =>
  renderToStaticMarkup(<ReplyGrantToggle orgId="o" granted={granted} canChange={canChange} />);

describe('ReplyGrantToggle', () => {
  it('checked state from props', () => {
    expect(render(true, true)).toContain('checked=""');
    expect(render(false, true)).not.toContain('checked');
  });

  it('disabled when !canChange', () => {
    expect(render(false, false)).toContain('disabled=""');
    expect(render(false, true)).not.toContain('disabled');
  });

  it('exact label and help text', () => {
    const html = render(false, true);
    expect(html).toContain('Members can reply to comments');
    expect(html).toContain('Owners and admins can always reply.');
  });
});
