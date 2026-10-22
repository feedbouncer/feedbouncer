import type { ReactNode } from 'react';
import { useActiveVersion } from '@docusaurus/plugin-content-docs/client';
import { REPO } from '../../site.config';

export default function RepoLink({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}): ReactNode {
  const version = useActiveVersion('default')?.name ?? 'current';
  const ref = version === 'current' ? 'main' : `v${version}`;
  return (
    <a href={`https://github.com/${REPO}/blob/${ref}/${path}`} rel="noopener noreferrer">
      {children}
    </a>
  );
}
