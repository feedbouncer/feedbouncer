import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * The top of every page: a title at the page scale (never the marketing site's hero scale),
 * an optional one-line description, and optional actions aligned to the title's baseline.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="flex flex-col gap-1.5">
        <h1>{title}</h1>
        {description ? <p className="text-dim">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
