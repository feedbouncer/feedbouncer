import { POLICY_ACTION_LABEL, previewSummary, type PreviewView } from '../../lib/policies';

export function PolicyPreview({ view }: { view: PreviewView }) {
  const matches = view.results.filter((r) => r.proposedAction !== null);
  return (
    <section aria-label="Preview">
      <p>{previewSummary(view)}</p>
      <p role="note">Dry run — nothing was hidden, deleted or logged.</p>
      {matches.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Comment</th>
              <th scope="col">Would</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((r) => (
              <tr key={r.commentId}>
                <td>{r.excerpt}</td>
                <td>{r.proposedAction ? POLICY_ACTION_LABEL[r.proposedAction] : null}</td>
                <td>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
