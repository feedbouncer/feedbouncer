import {
  CATEGORIES,
  CATEGORY_LABEL,
  classificationStatusText,
  formatScore,
  type ClassificationView,
} from '../../lib/classifier';
import { cn } from '../../lib/utils';

export function ClassificationSummary({
  classification,
}: {
  classification: ClassificationView | null;
}) {
  const c = classification;
  if (!c || c.status !== 'classified' || !c.scores)
    return (
      <p className="rounded-md border border-border/60 bg-elevated/30 p-3 text-dim">
        {classificationStatusText(c)}
      </p>
    );
  const triggered = new Set(c.triggers.map((t) => t.category));
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-elevated/30 p-3">
      <p className="font-medium">{classificationStatusText(c)}</p>
      <ul className="flex flex-col gap-1 text-small">
        {CATEGORIES.map((k) => {
          const triggeredCategory = triggered.has(k);
          return (
            <li
              key={k}
              className={cn(
                'flex items-center justify-between gap-3',
                triggeredCategory ? 'text-foreground' : 'text-dim',
              )}
            >
              <span className={triggeredCategory ? 'font-semibold' : undefined}>
                {CATEGORY_LABEL[k]}
              </span>
              <span className={cn('tabular-nums', triggeredCategory && 'font-semibold')}>
                {formatScore(c.scores![k])}
              </span>
            </li>
          );
        })}
      </ul>
      {c.truncated ? (
        <p className="text-small text-dim">Only the first 4,000 characters were classified.</p>
      ) : null}
      {c.lowSignal ? (
        <p className="text-small text-dim">
          Very short or emoji-only text, so destructive actions are disabled.
        </p>
      ) : null}
      {c.provider || c.model ? (
        <p className="text-small text-faint">
          Classified by {c.provider ?? 'unknown'} / {c.model ?? 'unknown'}
        </p>
      ) : null}
    </div>
  );
}
