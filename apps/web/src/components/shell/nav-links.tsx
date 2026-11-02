'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '../../lib/utils';
import { isActive, type NavItem } from '../../lib/nav';

export function NavLinks({
  items,
  label,
  variant = 'primary',
}: {
  items: NavItem[];
  label: string;
  /** `secondary` is the lighter-weight row nested under a `primary` nav (the brand sub-nav). */
  variant?: 'primary' | 'secondary';
}) {
  const pathname = usePathname();
  const secondary = variant === 'secondary';
  return (
    <nav
      aria-label={label}
      className={secondary ? 'border-t border-border/70 bg-elevated/40' : undefined}
    >
      <ul
        className={cn(
          'flex gap-1 overflow-x-auto whitespace-nowrap md:flex-wrap',
          secondary && 'py-1.5',
        )}
      >
        {items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center motion-safe:transition-colors duration-(--fb-dur-hover)',
                  secondary
                    ? 'min-h-8 rounded-md px-2.5 text-small font-medium'
                    : 'min-h-11 px-3 text-ui font-medium',
                  active
                    ? secondary
                      ? 'bg-accent text-foreground'
                      : 'border-b-2 border-coral text-foreground'
                    : secondary
                      ? 'text-faint hover:bg-accent/60 hover:text-dim'
                      : 'text-dim hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
