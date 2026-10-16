import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api-client';
import {
  runNotice,
  evaluationText,
  matchText,
  plural,
  policyDecisionText,
  policyErrorText,
  previewSummary,
  usageText,
  warningText,
  type EvaluationView,
  type PolicyMatchView,
  type PreviewView,
} from './policies';
import type { DecisionView } from './rules';

const view: PreviewView = {
  id: 'v1',
  status: 'done',
  text: 'Hide comments asking readers to message another account',
  action: 'hide',
  days: 7,
  since: '2026-10-08T00:00:00.000Z',
  total: 120,
  capped: false,
  examined: 120,
  matched: 0,
  errors: 0,
  notChecked: 0,
  stoppedReason: null,
  createdAt: '2026-10-15T10:00:00.000Z',
  completedAt: null,
  results: [],
};

const policyDecision: DecisionView = {
  id: 'd1',
  outcome: 'hide',
  mode: 'enforce',
  actorType: 'policy',
  rule: null,
  reason: 'reason',
  createdAt: '2026-10-15T10:00:00.000Z',
  fallback: false,
  action: null,
  classifier: null,
  policy: {
    evaluationId: 'e1',
    policyId: 'p1',
    name: 'No DM solicitations',
    archived: false,
    revision: 3,
    text: 'Hide comments asking readers to message another account',
    matches: [],
  },
};

const match: PolicyMatchView = {
  policyId: 'p2',
  name: 'No promo',
  archived: false,
  revision: 2,
  confidence: 'high',
  action: 'hide',
  effectiveAction: 'hide',
  downgrade: null,
};

const evaluation: EvaluationView = {
  id: 'e1',
  status: 'evaluated',
  skipReason: null,
  failureCode: null,
  outcome: null,
  createdAt: '2026-10-15T10:00:00.000Z',
  checkedCount: 3,
  triggerKey: 'ingest',
  matches: [],
};

describe('policies lib', () => {
  it('warning texts are concrete and suggest a fix', () => {
    expect(warningText('few_words')).toBe(
      'This policy is very short. Say what the comment does, for example “asks people to DM another account”.',
    );
    expect(warningText('vague_terms')).toBe(
      'Words like “bad” or “inappropriate” are hard to apply consistently. Describe the behaviour you want to catch.',
    );
  });

  it('usage text', () => {
    expect(usageText({ used: 20_000, limit: 20_000, resetsAt: '2026-11-01T00:00:00.000Z' })).toBe(
      'Monthly policy checks used: 20,000 of 20,000. Policies are paused until 1 November; comments are left unchanged.',
    );
    expect(usageText({ used: 12, limit: 20_000, resetsAt: '2026-11-01T00:00:00.000Z' })).toBe(
      'Monthly policy checks used: 12 of 20,000.',
    );
  });

  it('preview summary states the cap', () => {
    expect(previewSummary({ ...view, total: 200, capped: true, matched: 14, examined: 200 })).toBe(
      'Would act on 14 of the 200 most recent comments from the last 7 days. Older comments were not checked.',
    );
    expect(previewSummary({ ...view, status: 'running', examined: 40, total: 120 })).toBe(
      'Checking comments… 40 of 120.',
    );
    expect(
      previewSummary({ ...view, stoppedReason: 'quota_exhausted', examined: 3, notChecked: 7 }),
    ).toContain('The monthly policy-check limit was reached; 7 comments were not checked.');
  });

  it('preview summary reports comments that could not be checked', () => {
    expect(previewSummary({ ...view, examined: 1, matched: 1, errors: 1, days: 1 })).toBe(
      'Would act on 1 of 1 comment from the last 1 day. 1 comment could not be checked.',
    );
  });

  it('policy decision text names the policy and revision', () => {
    expect(policyDecisionText(policyDecision)).toBe(
      'Hidden by policy “No DM solicitations” (revision 3)',
    );
    expect(
      policyDecisionText({
        ...policyDecision,
        policy: { ...policyDecision.policy!, archived: true },
      }),
    ).toBe('Hidden by policy “No DM solicitations” (revision 3, deleted policy)');
  });

  it('match text explains a downgrade to flag', () => {
    expect(matchText(match)).toBe('“No promo” (revision 2) — hide');
    expect(
      matchText({
        ...match,
        confidence: 'low',
        effectiveAction: 'flag',
        downgrade: 'low_confidence',
      }),
    ).toBe('“No promo” (revision 2) — possible match, flagged for review instead of hide');
  });

  it('evaluation text explains failed, skipped and unmatched checks', () => {
    expect(evaluationText({ ...evaluation, status: 'failed', failureCode: 'unavailable' })).toBe(
      'Policy check failed: the AI provider was unavailable. The comment was left unchanged.',
    );
    expect(
      evaluationText({ ...evaluation, status: 'skipped', skipReason: 'quota_exhausted' }),
    ).toContain('monthly policy-check limit');
    expect(evaluationText(evaluation)).toBe('Checked against 3 policies: no policy matched.');
    expect(evaluationText({ ...evaluation, status: 'failed', failureCode: 'surprise' })).toBe(
      'Policy check failed. The comment was left unchanged.',
    );
  });

  it('plural keeps one singular', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(7, 'day')).toBe('7 days');
  });

  it('error text prefers field issues, then the API wording for limits', () => {
    const issue = [{ path: 'text', message: 'Write the policy as a sentence.' }];
    expect(policyErrorText(new ApiRequestError(400, 'invalid_policy', 'x', undefined, issue))).toBe(
      'Write the policy as a sentence.',
    );
    expect(
      policyErrorText(
        new ApiRequestError(
          409,
          'policy_limit_reached',
          'At most 10 policies can be enabled at once.',
        ),
      ),
    ).toBe('At most 10 policies can be enabled at once.');
    expect(policyErrorText(new ApiRequestError(409, 'policy_name_taken', 'server words'))).toBe(
      'Another policy already has this name.',
    );
    expect(policyErrorText(new Error('boom'))).toBe('Something went wrong.');
  });
});

describe('runNotice', () => {
  it('does not claim a start when there are no connections', () => {
    expect(runNotice(0)).toBe('No active connections to check.');
    expect(runNotice(1)).toBe('Started on 1 connection.');
    expect(runNotice(3)).toBe('Started on 3 connections.');
  });
});
