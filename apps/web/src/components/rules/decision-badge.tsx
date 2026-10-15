import { actorTypeText, outcomeText } from '../../lib/messages';
import { ACTION_LABEL, type DecisionView, type RuleAction } from '../../lib/rules';

const DONE: Record<RuleAction, string> = {
  approve: 'Allowed',
  flag: 'Flagged for review',
  hide: 'Hidden',
  remove: 'Deleted',
};

const VERB: Record<RuleAction, string> = {
  approve: 'allow',
  flag: 'flag for review',
  hide: 'hide',
  remove: 'delete',
};

const ATTEMPT: Record<string, string> = { hide: 'hide', delete: 'delete' };

export function decisionText(d: DecisionView): string {
  const who = d.rule ? `rule ${d.rule.name}` : actorTypeText(d.actorType);
  if (d.fallback) {
    const tried = d.action ? (ATTEMPT[d.action.kind] ?? 'act') : 'act';
    const why = d.action?.outcomeCode ? outcomeText(d.action.outcomeCode) : d.reason;
    return `Flagged for review: rule couldn't ${tried} (${why})`;
  }
  if (d.mode === 'suggest') return `Dry run: would ${VERB[d.outcome]} (${who})`;
  return `${DONE[d.outcome]} by ${who}`;
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
