import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Skeleton } from './ui/skeleton';
import { cn } from '../lib/utils';

export function LoadingPanel({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-busy="true" data-state="loading" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

export function ErrorPanel({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="alert" data-state="error" className="flex flex-col gap-2">
      <p className="flex items-center gap-2 font-semibold">
        <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
        {title}
      </p>
      {children}
    </div>
  );
}

export function TableScroll({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-table-scroll
      className={cn('w-full overflow-x-auto rounded-lg border border-border', className)}
    >
      {children}
    </div>
  );
}

export function ErrorFallback({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Card className="mx-auto max-w-form">
      <CardContent className="flex flex-col gap-4">
        <ErrorPanel title="Something went wrong">
          {error.digest ? <p className="text-small text-dim">Reference: {error.digest}</p> : null}
        </ErrorPanel>
        <div>
          <Button onClick={reset}>Try again</Button>
        </div>
      </CardContent>
    </Card>
  );
}
