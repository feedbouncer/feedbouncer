import type { ReactNode } from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import { useActiveVersion } from '@docusaurus/plugin-content-docs/client';

export default function SearchBar(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const version = useActiveVersion('default')?.name;
  return (
    <form action={`${siteConfig.baseUrl}search/`} method="get" role="search">
      <input
        type="search"
        name="q"
        aria-label="Search the documentation"
        placeholder="Search"
        className="navbar__search-input"
      />
      {version && <input type="hidden" name="version" value={version} />}
    </form>
  );
}
