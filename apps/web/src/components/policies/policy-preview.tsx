import { TableScroll } from '../states';
import { POLICY_ACTION_LABEL, previewSummary, type PreviewView } from '../../lib/policies';

export function PolicyPreview({ view }: { view: PreviewView }) {
  const matches = view.results.filter((r) => r.proposedAction !== null);
  return (
    <section
      aria-label="Preview"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-(--fb-card-pad)"
    >
      <p>{previewSummary(view)}</p>
      <p role="note">Dry run — nothing was hidden, deleted or logged.</p>
      {matches.length > 0 ? (
        <TableScroll>
          <table>
            <thead>
              <tr>
                <th scope="col" className="whitespace-nowrap">
                  Comment
                </th>
                <th scope="col" className="whitespace-nowrap">
                  Would
                </th>
                <th scope="col" className="whitespace-nowrap">
                  Reason
                </th>
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
        </TableScroll>
      ) : null}
    </section>
  );
}
