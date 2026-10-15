import { classifierEvidence } from '../../lib/classifier';
import { actorTypeText, outcomeText } from '../../lib/messages';
import { policyDecisionText } from '../../lib/policies';
import { ACTION_LABEL, OUTCOME_DONE, OUTCOME_VERB, type DecisionView } from '../../lib/rules';

const ATTEMPT: Record<string, string> = { hide: 'hide', delete: 'delete' };

export function decisionText(d: DecisionView): string {
  if (d.actorType === 'classifier' && d.classifier) {
    if (d.fallback) {
      const code = d.action?.outcomeCode;
      if (!d.action || !code) return d.reason;
      const tried = ATTEMPT[d.action.kind] ?? 'act';
      return `Flagged for review: classifier couldn't ${tried} (${outcomeText(code)})`;
    }
    const evidence = classifierEvidence(d.classifier);
    if (d.classifier.reversal) return `Unhidden by classifier: ${evidence}`;
    return `${OUTCOME_DONE[d.outcome]} by classifier: ${evidence}`;
  }
  if (d.actorType === 'policy' && d.policy) {
    if (!d.fallback) return policyDecisionText(d);
    if (!d.action) return d.reason;
    return `Flagged for review: a policy's ${ATTEMPT[d.action.kind] ?? 'action'} was not allowed by the platform`;
  }
  const who = d.rule ? `rule ${d.rule.name}` : actorTypeText(d.actorType);
  if (d.fallback) {
    const code = d.action?.outcomeCode;
    if (!d.action || !code) return d.reason;
    const tried = ATTEMPT[d.action.kind] ?? 'act';
    return `Flagged for review: rule couldn't ${tried} (${outcomeText(code)})`;
  }
  if (d.mode === 'suggest') return `Dry run: would ${OUTCOME_VERB[d.outcome]} (${who})`;
  return `${OUTCOME_DONE[d.outcome]} by ${who}`;
}

export function DecisionBadge({ decision }: { decision: DecisionView | null }) {
  if (!decision) return null;
  return (
    <span
      title={ACTION_LABEL[decision.outcome]}
      style={{
        display: 'inline-block',
        padding: '0 6px',
        border: '1px solid #999',
        borderRadius: 4,
        fontSize: '0.85em',
      }}
    >
      {decisionText(decision)}
    </span>
  );
}
