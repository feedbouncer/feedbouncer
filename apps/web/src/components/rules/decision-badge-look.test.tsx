import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DecisionView } from '../../lib/rules';
import { DecisionBadge } from './decision-badge';

const base: DecisionView = {
  id: 'd1',
  outcome: 'hide',
  mode: 'enforce',
  actorType: 'classifier',
  rule: null,
  reason: 'x',
  createdAt: '2026-10-15T10:00:00.000Z',
  fallback: false,
  action: null,
  classifier: {
    category: 'hate_speech',
    score: 0.93,
    threshold: 0.8,
    provider: 'openai',
    model: 'm',
    triggers: [],
    downgraded: null,
    reversal: false,
  },
  policy: null,
};

const render = (d: DecisionView) => renderToStaticMarkup(<DecisionBadge decision={d} />);

describe('DecisionBadge look follows the text', () => {
  it('uses the danger look for a classifier hide even in suggest mode', () => {
    const html = render({ ...base, mode: 'suggest' });
    expect(html).toContain('Hidden by classifier');
    expect(html).not.toMatch(/secondary/);
  });

  it('does not flag a non-fallback decision whose reason looks like a review reason', () => {
    const html = render({
      ...base,
      actorType: 'rule',
      classifier: null,
      reason: 'x (missing_permission:pages_manage_engagement). Flagged for review instead.',
    });
    expect(html).not.toContain('Flagged for review');
    expect(html).not.toMatch(/coral/);
  });

  it('uses coral for a fallback', () => {
    expect(render({ ...base, fallback: true })).toMatch(/coral/);
  });
});
