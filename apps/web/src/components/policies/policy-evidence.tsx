import { matchText, type PolicyEvidence as Evidence } from '../../lib/policies';

/** The policy text a decision was made under, and every other policy that matched. */
export function PolicyEvidence({ policy }: { policy: Evidence }) {
  const others = policy.matches.filter((m) => m.policyId !== policy.policyId);
  return (
    <div>
      <blockquote>{policy.text}</blockquote>
      {others.length > 0 ? (
        <ul>
          {others.map((m) => (
            <li key={m.policyId}>Also matched: {matchText(m)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
