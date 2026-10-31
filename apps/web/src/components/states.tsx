import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

export function EmptyPanel({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div data-state="empty">
      <p>{title}</p>
      {children}
    </div>
  );
}

export function LoadingPanel({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-state="loading"
      className="flex flex-col gap-3"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

export function ErrorPanel({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div role="alert" data-state="error" className="flex flex-col gap-2">
      <p className="flex items-center gap-2 font-semibold">
        <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
        {title}
      </p>
      {children}
      {action}
    </div>
  );
}

export function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div data-table-scroll className="w-full overflow-x-auto rounded-lg border border-border">
      {children}
    </div>
  );
}
