import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

/**
 * A minimal breadcrumb for a page one level below where the top nav reaches (e.g. editing a
 * single rule). Placed above the title, not as a link-soup paragraph after the content.
 */
export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 self-start text-small font-medium text-dim hover:text-foreground"
    >
      <ArrowLeft aria-hidden="true" className="size-3.5" />
      {children}
    </Link>
  );
}
