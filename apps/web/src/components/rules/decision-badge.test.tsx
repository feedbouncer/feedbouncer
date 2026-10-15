import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DecisionView } from '../../lib/rules';
import { DecisionBadge } from './decision-badge';

const base: DecisionView = {
  id: 'd1',
  outcome: 'hide',
  mode: 'enforce',
  actorType: 'rule',
  rule: { id: 'r1', name: 'Spam links', kind: 'link_domain', archived: false },
  reason: 'Link to a blocked domain',
  createdAt: '2026-10-15T10:00:00.000Z',
  fallback: false,
  action: null,
};

const render = (d: DecisionView | null) => renderToStaticMarkup(<DecisionBadge decision={d} />);

describe('DecisionBadge', () => {
  it('names the rule for an enforced decision', () => {
    expect(render(base)).toContain('Hidden by rule Spam links');
  });

  it('marks a dry run as a suggestion', () => {
    const html = render({
      ...base,
      outcome: 'remove',
      mode: 'suggest',
      rule: { ...base.rule!, name: 'Spam' },
    });
    expect(html).toContain('Dry run: would delete (rule Spam)');
  });

  it('explains a fallback to review', () => {
    const html = render({
      ...base,
      outcome: 'flag',
      fallback: true,
      reason: 'Facebook refused',
      action: { kind: 'delete', status: 'failed', outcomeCode: null },
    });
    expect(html).toContain('Flagged for review: rule couldn&#x27;t delete (Facebook refused)');
  });

  it('renders the reason as escaped text', () => {
    const html = render({
      ...base,
      outcome: 'flag',
      fallback: true,
      reason: '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders nothing without a decision', () => {
    expect(render(null)).toBe('');
  });
});
