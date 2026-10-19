import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RuleChangeView } from '../../lib/rule-changes';
import { RuleChangeReview } from './rule-change-review';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const change = (over: Partial<RuleChangeView> = {}): RuleChangeView => ({
  id: 'c1',
  operation: 'update',
  ruleId: 'r1',
  status: 'pending',
  before: null,
  after: null,
  diff: [{ field: 'action', before: 'flag', after: 'hide' }],
  warnings: [],
  rationale: 'Too many scam links',
  expiresAt: '2026-10-26T10:00:00.000Z',
  baseRuleRevision: 3,
  currentRuleRevision: 3,
  isStale: false,
  proposedBy: { apiKeyName: 'CI bot' },
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  ...over,
});

const render = (c: RuleChangeView, canDecide = true) =>
  renderToStaticMarkup(<RuleChangeReview orgId="o" brandId="b" change={c} canDecide={canDecide} />);

describe('RuleChangeReview', () => {
  it('renders diff rows', () => {
    const html = render(change());
    expect(html).toContain('action');
    expect(html).toContain('flag');
    expect(html).toContain('hide');
  });

  it('renders the rationale as text under an unverified label', () => {
    const html = render(change({ rationale: '<img src=x onerror=alert(1)>' }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Reason given by the API client (not verified)');
  });

  it('escapes rule names and values in the diff', () => {
    const html = render(change({ diff: [{ field: 'name', before: null, after: '<b>x</b>' }] }));
    expect(html).not.toContain('<b>x');
  });

  it('shows warnings, the expiry and the proposing key', () => {
    const html = render(change({ warnings: ['Never matches: the list is empty'] }));
    expect(html).toContain('Never matches: the list is empty');
    expect(html).toContain('2026-10-26 10:00 UTC');
    expect(html).toContain('CI bot');
  });

  it('offers Approve and Reject on a live pending proposal', () => {
    const html = render(change());
    expect(html).toContain('Approve');
    expect(html).toContain('Reject');
  });

  it('stale proposal hides Approve and shows the stale banner', () => {
    const html = render(change({ isStale: true }));
    expect(html).toContain('Rules changed since this was proposed — ask for a new proposal');
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('Reject');
  });

  it('member (canDecide=false) sees no buttons', () => {
    expect(render(change(), false)).not.toContain('<button');
  });

  it('shows no buttons once decided and names who decided', () => {
    const html = render(
      change({
        status: 'approved',
        decidedBy: { userId: 'u', name: 'Dana' },
        decidedAt: '2026-10-20T08:00:00.000Z',
        decisionNote: 'ok',
      }),
    );
    expect(html).not.toContain('<button');
    expect(html).toContain('Dana');
  });
});
