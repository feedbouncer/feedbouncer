import type { ReactNode } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import { useAllDocsData } from '@docusaurus/plugin-content-docs/client';
import RepoLink from '../components/RepoLink';

const AUDIENCES = [
  {
    title: 'I run FeedBouncer',
    text: 'Learn how comments are checked, what the rules and review mode do, and what is recorded.',
    to: '/docs/concepts/overview/',
  },
  {
    title: "I'm integrating with the API",
    text: 'Authenticate, make a first request and look up every endpoint.',
    // The quickstart page is written with the API section; until then the section overview is the entry point.
    to: '/docs/api/overview/',
  },
  {
    title: "I'm connecting an assistant (MCP)",
    text: 'Set up the MCP server in your client and see which tools it offers.',
    to: '/docs/mcp/overview/',
  },
];

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const docs = useAllDocsData();
  const latest = docs.default?.versions.find((v) => v.isLast);
  return (
    <Layout title={siteConfig.title} description="Documentation for FeedBouncer.">
      <main className="container margin-vert--lg">
        <h1>FeedBouncer documentation</h1>
        <p>
          Moderate the comments on your brand's social accounts, and see why every action happened.
        </p>
        <div className="row">
          {AUDIENCES.map((a) => (
            <div key={a.to} className="col col--4 margin-bottom--md">
              <div className="card padding--md">
                <h2>{a.title}</h2>
                <p>{a.text}</p>
                <Link to={a.to}>Start here</Link>
              </div>
            </div>
          ))}
        </div>
        <p>
          You are reading the docs for <strong>{latest?.label ?? 'main (unreleased)'}</strong>.{' '}
          <Link to="/versions">See all versions</Link>.
        </p>
        <p>
          Running your own instance? Read the{' '}
          <RepoLink path="docs/self-hosting/meta-app.md">self-host guide</RepoLink>.
        </p>
      </main>
    </Layout>
  );
}
