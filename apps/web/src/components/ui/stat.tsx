import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** A grid of StatCards; wraps to one column on narrow viewports. */
export function StatGrid({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3', className)}
      {...props}
    />
  );
}

/**
 * A single headline metric (comments processed, time saved, …): the number people glance at
 * first, so it gets real visual weight, not plain paragraph text.
 */
export function StatCard({
  label,
  value,
  note,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border border-border bg-card p-(--fb-card-pad)',
        className,
      )}
    >
      <span className="text-label font-semibold text-dim">{label}</span>
      <span className="font-display text-page leading-heading font-bold tracking-page tabular-nums">
        {value}
      </span>
      {note ? <span className="text-small text-faint">{note}</span> : null}
    </div>
  );
}
