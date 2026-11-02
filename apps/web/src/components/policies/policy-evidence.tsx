import { matchText, type PolicyEvidence as Evidence } from '../../lib/policies';

/** The policy text a decision was made under, and every other policy that matched. */
export function PolicyEvidence({ policy }: { policy: Evidence }) {
  const others = policy.matches.filter((m) => m.policyId !== policy.policyId);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-elevated/30 p-3">
      <blockquote className="border-s-2 border-border ps-3 text-dim italic">
        {policy.text}
      </blockquote>
      {others.length > 0 ? (
        <ul className="flex flex-col gap-1 text-small text-dim">
          {others.map((m) => (
            <li key={m.policyId}>Also matched: {matchText(m)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
