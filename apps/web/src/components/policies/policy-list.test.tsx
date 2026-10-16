import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PolicyDto, PolicyListDto } from '../../lib/policies';
import { PolicyList } from './policy-list';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const policy: PolicyDto = {
  id: 'p1',
  name: 'No DM solicitations',
  enabled: true,
  text: 'Hide comments telling people to DM another account',
  action: 'hide',
  revision: 1,
  revisionId: 'r1',
  warnings: [],
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
};

const list: PolicyListDto = {
  policies: [policy],
  limits: { maxPolicies: 20, maxEnabled: 10 },
  usage: { used: 12, limit: 20_000, resetsAt: '2026-11-01T00:00:00.000Z' },
  evaluatorConfigured: true,
};

const render = (l: PolicyListDto, canEdit = true) =>
  renderToStaticMarkup(<PolicyList orgId="o" brandId="b" list={l} canEdit={canEdit} />);

describe('PolicyList', () => {
  it('renders hostile names as inert text', () => {
    const html = render({
      ...list,
      policies: [{ ...policy, name: '<img src=x onerror=alert(1)>' }],
    });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('shows the action label, a pressed toggle and the usage line', () => {
    const html = render(list);
    expect(html).toContain('Hide');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Monthly policy checks used: 12 of 20,000.');
    expect(html).toContain('New policy');
  });

  it('labels the toggle with the action it performs', () => {
    expect(render(list)).toContain('aria-label="Disable No DM solicitations"');
    const off = render({ ...list, policies: [{ ...policy, enabled: false }] });
    expect(off).toContain('aria-label="Enable No DM solicitations"');
  });

  it('shows the paused banner when the monthly budget is used', () => {
    const html = render({ ...list, usage: { ...list.usage, used: 20_000 } });
    expect(html).toContain('Policies are paused until 1 November');
  });

  it('replaces the new-policy link at the limit', () => {
    const policies = Array.from({ length: 20 }, (_, i) => ({ ...policy, id: `p${i}` }));
    const html = render({ ...list, policies });
    expect(html).toContain('Limit reached (20)');
    expect(html).not.toContain('New policy');
  });

  it('shows a notice when the deployment has policy checks turned off', () => {
    expect(render({ ...list, evaluatorConfigured: false })).toContain(
      'Policy checks are turned off in this deployment.',
    );
  });

  it('hides editing controls from members', () => {
    const html = render(list, false);
    expect(html).not.toContain('New policy');
    expect(html).not.toContain('Delete');
    expect(html).toContain('disabled=""');
  });
});
