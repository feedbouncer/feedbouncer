import { Ban, Check, FlaskConical, Flag, Undo2, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { classifierEvidence } from '../../lib/classifier';
import { actorTypeText, outcomeText } from '../../lib/messages';
import { policyDecisionText } from '../../lib/policies';
import {
  ACTION_LABEL,
  OUTCOME_DONE,
  OUTCOME_VERB,
  reviewReasonText,
  type DecisionView,
} from '../../lib/rules';

const ATTEMPT: Record<string, string> = { hide: 'hide', delete: 'delete' };

export function decisionText(d: DecisionView): string {
  const review = d.fallback ? reviewReasonText(d.reason) : null;
  if (review) return `Flagged for review: ${review}`;
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

type BadgeLook = { variant: 'danger' | 'coral' | 'secondary' | 'good'; Icon: LucideIcon };

function badgeLook(d: DecisionView): BadgeLook {
  if (d.fallback || reviewReasonText(d.reason)) return { variant: 'coral', Icon: Flag };
  if (d.classifier?.reversal) return { variant: 'good', Icon: Undo2 };
  if (d.mode === 'suggest') return { variant: 'secondary', Icon: FlaskConical };
  if (d.outcome === 'flag') return { variant: 'coral', Icon: Flag };
  if (d.outcome === 'approve') return { variant: 'good', Icon: Check };
  return { variant: 'danger', Icon: Ban };
}

export function DecisionBadge({ decision }: { decision: DecisionView | null }) {
  if (!decision) return null;
  const { variant, Icon } = badgeLook(decision);
  return (
    <Badge
      variant={variant}
      title={ACTION_LABEL[decision.outcome]}
      className="h-auto max-w-full whitespace-normal"
    >
      <Icon aria-hidden="true" />
      {decisionText(decision)}
    </Badge>
  );
}
