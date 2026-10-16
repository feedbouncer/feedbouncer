import { formatUtc } from '../../lib/format';
import { POLICY_ACTION_LABEL, type PolicyDetailDto } from '../../lib/policies';

export function RevisionHistory({ revisions }: { revisions: PolicyDetailDto['revisions'] }) {
  return (
    <section aria-label="Revision history">
      <h2>Revision history</h2>
      <ol reversed>
        {revisions.map((r) => (
          <li key={r.id} value={r.revision}>
            <p>
              Revision {r.revision} · {POLICY_ACTION_LABEL[r.action]} · {formatUtc(r.createdAt)}
              {r.createdBy ? ` · ${r.createdBy.name ?? 'a former member'}` : null}
            </p>
            <blockquote>{r.text}</blockquote>
          </li>
        ))}
      </ol>
    </section>
  );
}
