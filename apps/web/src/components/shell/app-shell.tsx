import Link from 'next/link';
import type { ReactNode } from 'react';
import type { NavItem } from '../../lib/nav';
import { BrandSubNav } from './brand-sub-nav';
import { NavLinks } from './nav-links';
import { Wordmark } from './wordmark';

const linkClass =
  'inline-flex min-h-11 items-center text-ui font-medium text-dim hover:text-foreground';

export function AppShell({ nav, children }: { nav?: NavItem[]; children: ReactNode }) {
  return (
    <>
      <header
        data-shell="app"
        className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur-(--fb-blur-header)"
      >
        <div className="mx-auto w-full max-w-content px-(--fb-gutter)">
          <div className="flex min-h-(--fb-header-h) items-center justify-between gap-4">
            <Wordmark href="/orgs" />
            <div className="flex items-center gap-4">
              <Link href="/hidden-today" className={linkClass}>
                Hidden today
              </Link>
              <Link href="/account" className={linkClass}>
                Account
              </Link>
            </div>
          </div>
          {nav ? <NavLinks label="Organization" items={nav} /> : null}
          {nav ? <BrandSubNav /> : null}
        </div>
      </header>
      <div
        id="content"
        tabIndex={-1}
        className="mx-auto w-full max-w-content px-(--fb-gutter) py-8"
      >
        {children}
      </div>
    </>
  );
}
