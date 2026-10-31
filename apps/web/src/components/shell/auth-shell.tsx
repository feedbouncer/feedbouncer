import type { ReactNode } from 'react';
import { SkipLink } from './skip-link';
import { Wordmark } from './wordmark';

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <>
      <SkipLink />
      <div className="grid min-h-dvh place-items-center px-4 py-10">
        <div className="flex w-full max-w-form flex-col items-center gap-6">
          <Wordmark href="/" />
          <div
            id="content"
            tabIndex={-1}
            data-shell="auth"
            className="w-full max-w-form rounded-xl border bg-card p-(--fb-card-pad) shadow-panel"
          >
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
