import { ACTION_SEVERITY, describeDecision as describeRule } from '@feedbouncer/rules';
import type { RuleAction, RuleHit } from '@feedbouncer/rules';
import { describeClassification, type ClassifierVerdict } from '@feedbouncer/classifier';
import { describeDecision as describePolicy, type PolicyDecision } from '@feedbouncer/policies';
import { toVerdict, type CheckResult, type ReasonCode } from './types.js';

export type ClassifierStage =
  | { kind: 'ok'; verdict: ClassifierVerdict; language: string; provider: string; model: string }
  | { kind: 'failed'; code: string }
  | { kind: 'not_configured' };
export type PolicyStage =
  | { kind: 'ok'; decision: PolicyDecision; provider: string; model: string }
  | { kind: 'skipped' }
  | { kind: 'failed'; code: string };

const NO_EVIDENCE: CheckResult['evidence'] = {
  ruleId: null,
  ruleName: null,
  category: null,
  score: null,
  threshold: null,
  policyId: null,
  policyRevision: null,
  language: null,
};

function degradedReason(
  classifier: ClassifierStage | null,
  policy: PolicyStage | null,
): { reasonCode: ReasonCode; reason: string } | null {
  if (classifier?.kind === 'failed') {
    return {
      reasonCode: 'classifier_unavailable',
      reason: `Held for review: the classifier could not be reached (${classifier.code}), so this text was not fully checked.`,
    };
  }
  if (classifier?.kind === 'not_configured') {
    return {
      reasonCode: 'classifier_not_configured',
      reason: 'Held for review: no classifier is configured on this instance and no rule decided.',
    };
  }
  if (policy?.kind === 'failed') {
    return {
      reasonCode: 'policy_unavailable',
      reason: `Held for review: the policy check could not be completed (${policy.code}).`,
    };
  }
  return null;
}

/** `classifier` and `policy` are null only when a rule decided. */
export function combine(
  rule: RuleHit | null,
  classifier: ClassifierStage | null,
  policy: PolicyStage | null,
): CheckResult {
  const models: CheckResult['models'] = {
    classifier:
      classifier?.kind === 'ok' ? { provider: classifier.provider, model: classifier.model } : null,
    policy: policy?.kind === 'ok' ? { provider: policy.provider, model: policy.model } : null,
  };
  const language = classifier?.kind === 'ok' ? classifier.language : null;

  if (rule) {
    return {
      verdict: toVerdict(rule.action),
      reasonCode: 'rule_matched',
      reason: describeRule(rule),
      decidedBy: 'rule',
      degraded: false,
      evidence: { ...NO_EVIDENCE, ruleId: rule.ruleId, ruleName: rule.ruleName },
      models,
    };
  }

  const fromClassifier = classifier?.kind === 'ok' ? classifier.verdict.outcome : null;
  const fromPolicy = policy?.kind === 'ok' ? policy.decision.outcome : null;
  const classifierWins =
    fromClassifier !== null &&
    (fromPolicy === null || ACTION_SEVERITY[fromClassifier] >= ACTION_SEVERITY[fromPolicy]);
  const action: RuleAction | null = classifierWins ? fromClassifier : fromPolicy;
  const degradedBy = degradedReason(classifier, policy);

  if (action !== null && (degradedBy === null || ACTION_SEVERITY[action] >= ACTION_SEVERITY.flag)) {
    const degraded = degradedBy !== null;
    if (classifierWins && classifier?.kind === 'ok') {
      const p = classifier.verdict.primary;
      return {
        verdict: toVerdict(action),
        reasonCode: 'classifier_threshold',
        reason: describeClassification(classifier.verdict, { truncated: false }),
        decidedBy: 'classifier',
        degraded,
        evidence: {
          ...NO_EVIDENCE,
          category: p?.category ?? null,
          score: p?.score ?? null,
          threshold: p?.threshold ?? null,
          language,
        },
        models,
      };
    }
    if (policy?.kind === 'ok') {
      return {
        verdict: toVerdict(action),
        reasonCode: 'policy_matched',
        reason: describePolicy(policy.decision, { truncated: false }),
        decidedBy: 'policy',
        degraded,
        evidence: {
          ...NO_EVIDENCE,
          policyId: policy.decision.winner?.policyId ?? null,
          policyRevision: policy.decision.winner?.revision ?? null,
          language,
        },
        models,
      };
    }
  }

  if (degradedBy) {
    return {
      verdict: 'review',
      ...degradedBy,
      decidedBy: 'degraded',
      degraded: true,
      evidence: { ...NO_EVIDENCE, language },
      models,
    };
  }
  return {
    verdict: 'allow',
    reasonCode: 'no_match',
    reason: 'No rule, classifier category or policy matched.',
    decidedBy: 'none',
    degraded: false,
    evidence: { ...NO_EVIDENCE, language },
    models,
  };
}
