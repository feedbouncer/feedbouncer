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
  it('explains low_signal and moderator_acted downgrades', () => {
    const a = m({ action: 'remove', effectiveAction: 'flag', downgrade: 'low_signal' });
    const b = m({
      policyId: 'p2',
      revisionId: 'r2',
      name: 'Other',
      action: 'hide',
      effectiveAction: 'flag',
      downgrade: 'moderator_acted',
    });
    const s = describeDecision(
      { outcome: 'flag', winner: a, matches: [a, b] },
      { truncated: false },
    );
    expect(s).toContain('too little text to act on, flagged for review instead of delete.');
    expect(s).toContain(
      'a moderator already acted on this comment, flagged for review instead of hide.',
    );
  });
  it('caps the list with "and N more", keeps the truncation note, never splits a code point', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      m({ policyId: `p${i}`, revisionId: `r${i}`, name: '𝒳'.repeat(80) }),
    );
    const s = describeDecision(
      { outcome: 'hide', winner: many[0]!, matches: many },
      { truncated: true },
    );
    expect(s.length).toBeLessThanOrEqual(2000);
    expect(s).toMatch(/and \d+ more\./);
    expect(s.endsWith('Only the first 4,000 characters of the comment were checked.')).toBe(true);
    expect(s).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
  it('last-resort cap is code-point safe', () => {
    const w = m({ name: '𝒳'.repeat(80) });
    const s = describeDecision({ outcome: 'hide', winner: w, matches: [w] }, { truncated: true });
    expect(s.length).toBeLessThanOrEqual(2000);
    expect(s).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
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
  it('states low_signal and moderator_acted reasons', () => {
    expect(
      describePreviewResult(
        {
          verdict: 'clear_match',
          action: 'hide',
          effectiveAction: 'flag',
          downgrade: 'low_signal',
        },
        { truncated: false },
      ),
    ).toBe('Clear match: would flag for review instead of hide (too little text to act on).');
    expect(
      describePreviewResult(
        {
          verdict: 'clear_match',
          action: 'remove',
          effectiveAction: 'flag',
          downgrade: 'moderator_acted',
        },
        { truncated: false },
      ),
    ).toBe(
      'Clear match: would flag for review instead of delete (a moderator already acted on this comment).',
    );
  });
  it('handles no_match explicitly', () => {
    expect(
      describePreviewResult(
        { verdict: 'no_match', action: 'hide', effectiveAction: 'hide', downgrade: null },
        { truncated: false },
      ),
    ).toBe('No match: no action would be taken.');
  });
  it('keeps the truncation note under the 500 cap', () => {
    const s = describePreviewResult(
      { verdict: 'clear_match', action: 'hide', effectiveAction: 'hide', downgrade: null },
      { truncated: true },
    );
    expect(s.length).toBeLessThanOrEqual(500);
    expect(s).toContain('4,000 characters');
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
  it('fallback text replaces unsafe codes', () => {
    expect(describeFallback('delete', 'Bad <code>')).toContain('(refused)');
  });
  it('fallback text', () => {
    expect(describeFallback('hide', 'not_eligible')).toBe(
      'A policy asked to hide this comment, but the platform did not allow it (not_eligible). Flagged for review instead.',
    );
  });
});
