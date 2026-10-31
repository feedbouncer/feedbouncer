import type { ReactNode } from 'react';
import { SkipLink } from './skip-link';
import { Wordmark } from './wordmark';

export function ScanShell({ children }: { children: ReactNode }) {
  return (
    <>
      <SkipLink />
      <header
        data-shell="scan"
        className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur-[10px]"
      >
        <div className="mx-auto flex min-h-(--fb-header-h) w-full max-w-content items-center px-(--fb-gutter)">
          <Wordmark href="/scan" />
        </div>
      </header>
      <div id="content" tabIndex={-1} className="scan-grain relative overflow-hidden">
        <div aria-hidden="true" className="scan-glow-accent" />
        <div aria-hidden="true" className="scan-glow-good" />
        <div className="relative mx-auto max-w-content px-(--fb-gutter) py-(--fb-section-y)">
          {children}
        </div>
      </div>
    </>
  );
}
