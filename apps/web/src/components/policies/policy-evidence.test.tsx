import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PolicyEvidence as Evidence } from '../../lib/policies';
import { PolicyEvidence } from './policy-evidence';

const evidence: Evidence = {
  evaluationId: 'e1',
  policyId: 'p1',
  name: 'No DM solicitations',
  archived: false,
  revision: 3,
  text: 'Hide comments asking readers to message another account',
  matches: [
    {
      policyId: 'p1',
      name: 'No DM solicitations',
      archived: false,
      revision: 3,
      confidence: 'high',
      action: 'hide',
      effectiveAction: 'hide',
      downgrade: null,
    },
    {
      policyId: 'p2',
      name: 'No promo',
      archived: true,
      revision: 1,
      confidence: 'low',
      action: 'remove',
      effectiveAction: 'flag',
      downgrade: 'low_confidence',
    },
  ],
};

describe('PolicyEvidence', () => {
  it('quotes the policy text and lists the other matches', () => {
    const html = renderToStaticMarkup(<PolicyEvidence policy={evidence} />);
    expect(html).toContain('<blockquote>Hide comments asking readers to message another account');
    expect(html).toContain(
      'Also matched: “No promo” (revision 1, deleted policy) — possible match, flagged for review instead of delete',
    );
    expect(html).not.toContain('Also matched: “No DM solicitations”');
  });
});
