import {
  CATEGORIES,
  CATEGORY_LABEL,
  classificationStatusText,
  formatScore,
  type ClassificationView,
} from '../../lib/classifier';

export function ClassificationSummary({
  classification,
}: {
  classification: ClassificationView | null;
}) {
  const c = classification;
  if (!c || c.status !== 'classified' || !c.scores) return <p>{classificationStatusText(c)}</p>;
  const triggered = new Set(c.triggers.map((t) => t.category));
  return (
    <div>
      <p>{classificationStatusText(c)}</p>
      <ul>
        {CATEGORIES.map((k) => {
          const text = `${CATEGORY_LABEL[k]}: ${formatScore(c.scores![k])}`;
          return <li key={k}>{triggered.has(k) ? <strong>{text}</strong> : text}</li>;
        })}
      </ul>
      {c.truncated ? <p>Only the first 4,000 characters were classified.</p> : null}
      {c.lowSignal ? (
        <p>Very short or emoji-only text, so destructive actions are disabled.</p>
      ) : null}
      {c.provider || c.model ? (
        <p>
          Classified by {c.provider ?? 'unknown'} / {c.model ?? 'unknown'}
        </p>
      ) : null}
    </div>
  );
}
