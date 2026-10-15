import { transitionText, type PreviewResult } from '../../lib/classifier';
import { formatUtc } from '../../lib/format';

export function PreviewPanel({ result }: { result: PreviewResult }) {
  const transitions = Object.entries(result.transitions);
  return (
    <section aria-label="Preview">
      <p>
        Would change {result.changed} of {result.examined} comments ({formatUtc(result.window.from)}{' '}
        to {formatUtc(result.window.to)})
      </p>
      {result.capped ? <p>Showing the most recent 20,000 comments.</p> : null}
      {transitions.length > 0 ? (
        <ul>
          {transitions.map(([key, n]) => (
            <li key={key}>
              {transitionText(key)}: {n}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
