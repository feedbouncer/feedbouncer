import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';

export default function Term({ id, children }: { id: string; children: ReactNode }): ReactNode {
  return <Link to={`/docs/concepts/glossary#${id}`}>{children}</Link>;
}
