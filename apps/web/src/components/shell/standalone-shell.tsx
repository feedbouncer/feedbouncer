import type { ReactNode } from 'react';
import { Wordmark } from './wordmark';

export function StandaloneShell({ children }: { children: ReactNode }) {
  return (
    <>
      <header data-shell="standalone" className="border-b border-border">
        <div className="mx-auto flex min-h-(--fb-header-h) w-full max-w-content items-center px-(--fb-gutter)">
          <Wordmark href="/" />
        </div>
      </header>
      <div
        id="content"
        tabIndex={-1}
        className="mx-auto w-full max-w-content px-(--fb-gutter) py-10"
      >
        {children}
      </div>
    </>
  );
}
