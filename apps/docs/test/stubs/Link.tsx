import type { ReactNode } from 'react';

export default function Link({ to, children }: { to: string; children: ReactNode }): ReactNode {
  return <a href={to}>{children}</a>;
}
