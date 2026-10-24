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
  classifier: null,
  policy: null,
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
      reason: 'Rule "Scams" wanted to delete this comment, but it was refused.',
      action: { kind: 'delete', status: 'failed', outcomeCode: 'unsupported' },
    });
    expect(html).toContain('Flagged for review: rule couldn&#x27;t delete (');
    expect(html).not.toContain('wanted to delete');
  });

  it('shows the fallback sentence alone when no outcome code is known', () => {
    const reason = 'Rule "Scams" wanted to hide this comment, but it is rate limited.';
    const html = render({ ...base, outcome: 'flag', fallback: true, reason, action: null });
    expect(html).toContain('Rule &quot;Scams&quot; wanted to hide this comment');
    expect(html).not.toContain('rule couldn&#x27;t');
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

  describe('review reasons', () => {
    const flagged = (reason: string): string =>
      render({ ...base, outcome: 'flag', fallback: true, reason, action: null });

    it('explains an action the platform does not support', () => {
      expect(
        flagged(
          'Rule "Scams" wanted to delete this comment, but TikTok ads does not allow it (action_not_supported:tiktok_ads:delete). Flagged for review instead.',
        ),
      ).toContain('Flagged for review: TikTok ads don&#x27;t support delete; review manually.');
      expect(flagged('x (action_not_supported:tiktok:auto_reply). y')).toContain(
        'TikTok doesn&#x27;t support auto-reply; review manually.',
      );
    });

    it('names a missing permission', () => {
      expect(flagged('x (missing_permission:comment.list.manage). y')).toContain(
        'Flagged for review: Missing permission comment.list.manage.',
      );
    });

    it('a reason containing <script> renders literally', () => {
      const reason = 'Rule "x" (missing_permission:<script>alert(1)</script>). Flagged.';
      const html = flagged(reason);
      expect(html).not.toContain('<script');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('Missing permission');
      const named = flagged('Rule "<script>x</script>" (action_not_supported:tiktok:delete).');
      expect(named).not.toContain('<script');
      expect(named).toContain('TikTok doesn&#x27;t support delete; review manually.');
    });

    it('an unknown platform or step falls back to the reason text', () => {
      const html = flagged('Rule "x" (action_not_supported:myspace:delete). Flagged.');
      expect(html).toContain('action_not_supported:myspace:delete');
      expect(flagged('(action_not_supported:tiktok:explode)')).toContain('tiktok:explode');
    });
  });

  it('renders nothing without a decision', () => {
    expect(render(null)).toBe('');
  });

  describe('classifier decisions', () => {
    const clf = (over: object, evidence: object = {}): DecisionView => ({
      ...base,
      actorType: 'classifier',
      rule: null,
      classifier: {
        category: 'hate_speech',
        score: 0.93,
        threshold: 0.8,
        provider: 'openai',
        model: 'm',
        triggers: [],
        downgraded: null,
        reversal: false,
        ...evidence,
      },
      ...over,
    });

    it('names category, score and threshold', () => {
      expect(render(clf({}))).toContain('Hidden by classifier: Hate speech 0.93 ≥ 0.80');
    });

    it('reads a reversal as unhidden', () => {
      const html = render(clf({ outcome: 'approve' }, { score: 0.1, reversal: true }));
      expect(html).toContain('Unhidden by classifier: Hate speech 0.10 &lt; 0.80');
    });

    it('reads a fallback as flagged', () => {
      const html = render(
        clf({
          outcome: 'flag',
          fallback: true,
          action: { kind: 'hide', status: 'failed', outcomeCode: 'unsupported' },
        }),
      );
      expect(html).toContain(
        'Flagged for review: classifier couldn&#x27;t hide (Not available on this platform.)',
      );
    });
  });

  describe('policy decisions', () => {
    const policyDecision = (over: Partial<DecisionView> = {}): DecisionView => ({
      ...base,
      actorType: 'policy',
      rule: null,
      policy: {
        evaluationId: 'e1',
        policyId: 'p1',
        name: 'No DM solicitations',
        archived: false,
        revision: 3,
        text: 'Hide comments asking readers to message another account',
        matches: [],
      },
      ...over,
    });

    it('names the policy and its revision', () => {
      expect(render(policyDecision())).toContain(
        'Hidden by policy “No DM solicitations” (revision 3)',
      );
    });

    it('labels a deleted policy', () => {
      const d = policyDecision();
      const html = render({ ...d, policy: { ...d.policy!, archived: true } });
      expect(html).toContain('(revision 3, deleted policy)');
    });

    it('reads a fallback as flagged', () => {
      const html = render(
        policyDecision({
          outcome: 'flag',
          fallback: true,
          action: { kind: 'hide', status: 'failed', outcomeCode: 'unsupported' },
        }),
      );
      expect(html).toContain(
        'Flagged for review: a policy&#x27;s hide was not allowed by the platform',
      );
    });

    it('renders a hostile policy name as inert text', () => {
      const d = policyDecision();
      const html = render({ ...d, policy: { ...d.policy!, name: '<img src=x onerror=alert(1)>' } });
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
  });
});
