import { describe, expect, it } from 'vitest';
import type { RuleAction, RuleHit } from '@feedbouncer/rules';
import type { ClassifierVerdict } from '@feedbouncer/classifier';
import type { PolicyAction, PolicyDecision } from '@feedbouncer/policies';
import { combine, type ClassifierStage, type PolicyStage } from './combine.js';

const hit = (action: RuleAction): RuleHit => ({
  ruleId: 'r1',
  ruleName: 'No scams',
  kind: 'keyword',
  action,
  actions: [],
  evidence: { kind: 'keyword', term: 'scam' },
});
const cls = (action: RuleAction | null): ClassifierStage => {
  const primary =
    action === null
      ? null
      : {
          category: 'spam' as const,
          score: 0.91,
          threshold: 0.8,
          action,
          effectiveAction: action,
        };
  const verdict: ClassifierVerdict = {
    outcome: action,
    primary,
    triggers: primary ? [primary] : [],
    downgraded: null,
  };
  return { kind: 'ok', verdict, language: 'en', provider: 'p', model: 'm' };
};
const pol = (action: PolicyAction | null): PolicyStage => {
  const winner =
    action === null
      ? null
      : {
          policyId: 'pol1',
          revisionId: 'rev1',
          revision: 3,
          name: 'No refunds talk',
          confidence: 'high' as const,
          action,
          effectiveAction: action,
          downgrade: null,
        };
  const decision: PolicyDecision = {
    outcome: action,
    winner,
    matches: winner ? [winner] : [],
  };
  return { kind: 'ok', decision, provider: 'pp', model: 'pm' };
};
const skipped: PolicyStage = { kind: 'skipped' };

describe('combine', () => {
  it.each([
    ['rule approve', hit('approve'), null, null, 'allow', 'rule_matched', 'rule', false],
    ['rule remove', hit('remove'), null, null, 'block', 'rule_matched', 'rule', false],
    [
      'classifier hide beats policy flag',
      null,
      cls('hide'),
      pol('flag'),
      'block',
      'classifier_threshold',
      'classifier',
      false,
    ],
    [
      'policy remove beats classifier flag',
      null,
      cls('flag'),
      pol('remove'),
      'block',
      'policy_matched',
      'policy',
      false,
    ],
    [
      'tie goes to the classifier',
      null,
      cls('hide'),
      pol('hide'),
      'block',
      'classifier_threshold',
      'classifier',
      false,
    ],
    ['nothing matched', null, cls(null), skipped, 'allow', 'no_match', 'none', false],
    [
      'classifier timeout',
      null,
      { kind: 'failed', code: 'timeout' },
      skipped,
      'review',
      'classifier_unavailable',
      'degraded',
      true,
    ],
    [
      'no classifier configured',
      null,
      { kind: 'not_configured' },
      skipped,
      'review',
      'classifier_not_configured',
      'degraded',
      true,
    ],
    [
      'failed classifier, policy remove',
      null,
      { kind: 'failed', code: 'timeout' },
      pol('remove'),
      'block',
      'policy_matched',
      'policy',
      true,
    ],
    [
      'classifier flag, failed policy',
      null,
      cls('flag'),
      { kind: 'failed', code: 'unavailable' },
      'review',
      'classifier_threshold',
      'classifier',
      true,
    ],
    [
      'failed policy, nothing else',
      null,
      cls(null),
      { kind: 'failed', code: 'unavailable' },
      'review',
      'policy_unavailable',
      'degraded',
      true,
    ],
    [
      'exhausted policy budget',
      null,
      cls(null),
      { kind: 'quota_exhausted' },
      'review',
      'policy_quota_exhausted',
      'degraded',
      true,
    ],
  ] as const)('%s', (_, rule, classifier, policy, verdict, reasonCode, decidedBy, degraded) => {
    expect(combine(rule, classifier, policy)).toMatchObject({
      verdict,
      reasonCode,
      decidedBy,
      degraded,
    });
  });

  it.each([
    [
      { kind: 'failed', code: 'timeout' } as const,
      'Held for review: the classifier could not be reached (timeout), so this text was not fully checked.',
    ],
    [
      { kind: 'not_configured' } as const,
      'Held for review: no classifier is configured on this instance and no rule decided.',
    ],
  ])('uses the exact classifier degraded copy', (classifier, reason) => {
    expect(combine(null, classifier, skipped).reason).toBe(reason);
  });

  it('uses the exact policy and no-match copy', () => {
    expect(combine(null, cls(null), { kind: 'failed', code: 'unavailable' }).reason).toBe(
      'Held for review: the policy check could not be completed (unavailable).',
    );
    expect(combine(null, cls(null), { kind: 'quota_exhausted' }).reason).toBe(
      "Held for review: this brand's monthly policy-check budget is used up.",
    );
    expect(combine(null, cls(null), skipped).reason).toBe(
      'No rule, classifier category or policy matched.',
    );
  });

  it('reports rule, classifier and policy evidence', () => {
    expect(combine(hit('remove'), null, null).evidence).toMatchObject({
      ruleId: 'r1',
      ruleName: 'No scams',
    });
    const c = combine(null, cls('hide'), pol('flag'));
    expect(c.evidence).toEqual({
      ruleId: null,
      ruleName: null,
      category: 'spam',
      score: 0.91,
      threshold: 0.8,
      policyId: null,
      policyRevision: null,
      language: 'en',
    });
    expect(c.models).toEqual({
      classifier: { provider: 'p', model: 'm' },
      policy: { provider: 'pp', model: 'pm' },
    });
    expect(combine(null, cls(null), pol('flag')).evidence).toMatchObject({
      policyId: 'pol1',
      policyRevision: 3,
      category: null,
    });
  });
});
