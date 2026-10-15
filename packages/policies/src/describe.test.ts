import { describe, expect, it } from 'vitest';
import {
  describeDecision,
  describeFallback,
  describePreviewResult,
  FAILURE_TEXT,
  SKIP_TEXT,
} from './describe.js';
import { FAILURE_CODES, SKIP_REASONS, type PolicyMatch } from './types.js';

const m = (o: Partial<PolicyMatch>): PolicyMatch => ({
  policyId: 'p1',
  revisionId: 'r1',
  revision: 3,
  name: 'No DM solicitations',
  confidence: 'high',
  action: 'hide',
  effectiveAction: 'hide',
  downgrade: null,
  ...o,
});

describe('describeDecision', () => {
  it('names the policy, revision and action', () => {
    const w = m({});
    expect(
      describeDecision({ outcome: 'hide', winner: w, matches: [w] }, { truncated: false }),
    ).toBe('Matched policy “No DM solicitations” (revision 3): hide.');
  });
  it('lists other matches and explains downgrades and truncation', () => {
    const w = m({});
    const low = m({
      policyId: 'p2',
      revisionId: 'r2',
      revision: 1,
      name: 'Off-topic links',
      confidence: 'low',
      action: 'remove',
      effectiveAction: 'flag',
      downgrade: 'low_confidence',
    });
    const s = describeDecision(
      { outcome: 'hide', winner: w, matches: [w, low] },
      { truncated: true },
    );
    expect(s).toContain(
      'Also matched: “Off-topic links” (revision 1) — possible match, flagged for review instead of delete.',
    );
    expect(s).toContain('Only the first 4,000 characters of the comment were checked.');
  });
  it('is capped at 2000 characters', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      m({ policyId: `p${i}`, revisionId: `r${i}`, name: 'n'.repeat(80) }),
    );
    expect(
      describeDecision({ outcome: 'hide', winner: many[0]!, matches: many }, { truncated: true })
        .length,
    ).toBeLessThanOrEqual(2000);
  });
  it('never includes anything but names, numbers and fixed wording', () => {
    const w = m({ name: '<b>x</b>' });
    expect(
      describeDecision({ outcome: 'hide', winner: w, matches: [w] }, { truncated: false }),
    ).toContain('“<b>x</b>”');
  });
});

describe('describePreviewResult', () => {
  it('explains a low-confidence match', () => {
    expect(
      describePreviewResult(
        {
          verdict: 'possible_match',
          action: 'hide',
          effectiveAction: 'flag',
          downgrade: 'low_confidence',
        },
        { truncated: false },
      ),
    ).toBe('Possible match: would flag for review instead of hide.');
  });
  it('explains a clear match', () => {
    expect(
      describePreviewResult(
        { verdict: 'clear_match', action: 'remove', effectiveAction: 'remove', downgrade: null },
        { truncated: false },
      ),
    ).toBe('Clear match: would delete.');
  });
});

describe('texts', () => {
  it('cover every skip reason and failure code', () => {
    for (const r of SKIP_REASONS) expect(SKIP_TEXT[r].length).toBeGreaterThan(0);
    for (const c of FAILURE_CODES) expect(FAILURE_TEXT[c].length).toBeGreaterThan(0);
  });
  it('fallback text', () => {
    expect(describeFallback('hide', 'not_eligible')).toBe(
      'A policy asked to hide this comment, but the platform did not allow it (not_eligible). Flagged for review instead.',
    );
  });
});
