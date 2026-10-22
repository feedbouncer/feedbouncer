import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import { useLocation } from '@docusaurus/router';
import { useAllDocsData } from '@docusaurus/plugin-content-docs/client';
import SearchView from '../search/SearchView';
import { versionForPath, type Pagefind } from '../search/core';
import { docsVersions } from '../search/versions';

export default function Search(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const { baseUrl } = siteConfig;
  const { search } = useLocation();
  const docs = useAllDocsData();
  const versions = docsVersions(docs.default?.versions ?? [], baseUrl);
  // The static page is built without a query; read it after mount so hydration matches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const params = new URLSearchParams(mounted ? search : '');
  const requested = params.get('version') ?? '';
  const version = versions.some((v) => v.name === requested)
    ? requested
    : versionForPath('', versions);
  const loadPagefind = useCallback(
    () => import(/* webpackIgnore: true */ `${baseUrl}pagefind/pagefind.js`) as Promise<Pagefind>,
    [baseUrl],
  );

  return (
    <Layout title="Search" description="Search the FeedBouncer documentation.">
      <main className="container margin-vert--lg">
        <h1>Search</h1>
        <SearchView
          q={params.get('q') ?? ''}
          version={version}
          baseUrl={baseUrl}
          loadPagefind={loadPagefind}
        />
      </main>
    </Layout>
  );
}
