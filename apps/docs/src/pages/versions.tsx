import type { ReactNode } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import { useAllDocsData } from '@docusaurus/plugin-content-docs/client';

export default function Versions(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const versions = useAllDocsData().default?.versions ?? [];
  const current = versions.find((v) => v.name === 'current');
  const released = versions.filter((v) => v.name !== 'current');
  // Version paths carry the base URL, and Link adds it again.
  // The docs root has no page of its own, so each link opens that version's Concepts overview.
  const to = (path: string) =>
    `/${path.slice(siteConfig.baseUrl.length).replace(/^\/+|\/+$/g, '')}/concepts/overview/`;
  return (
    <Layout title="All versions" description="Every documented FeedBouncer version.">
      <main className="container margin-vert--lg">
        <h1>All versions</h1>
        <h2>Development</h2>
        <ul>
          <li>
            <Link to={to(current?.path ?? `${siteConfig.baseUrl}docs`)}>main (unreleased)</Link>:
            documents the code on the main branch, which may not be released yet.
          </li>
        </ul>
        <h2>Released</h2>
        {released.length ? (
          <ul>
            {released.map((v) => (
              <li key={v.name}>
                <Link to={to(v.path)}>{v.label}</Link>
                {v.isLast ? ' (latest)' : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p>There are no releases yet.</p>
        )}
      </main>
    </Layout>
  );
}
