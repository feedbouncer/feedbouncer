import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReportSubscriptionToggle } from './ReportSubscriptionToggle';

const render = (subscribed: boolean) =>
  renderToStaticMarkup(
    <ReportSubscriptionToggle orgId="o1" orgName="<b>Acme</b>" subscribed={subscribed} />,
  );

describe('ReportSubscriptionToggle', () => {
  it('one checkbox per workspace, checked when subscribed, name as text', () => {
    expect(render(true)).toContain('checked=""');
    expect(render(false)).not.toContain('checked');
    expect(render(true)).toContain('Weekly report for &lt;b&gt;Acme&lt;/b&gt;');
  });
});
