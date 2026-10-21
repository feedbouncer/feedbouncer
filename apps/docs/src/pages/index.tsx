import type { ReactNode } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';

// Stub: replaced by the real landing page.
export default function Home(): ReactNode {
  return (
    <Layout title="FeedBouncer documentation" description="Documentation for FeedBouncer.">
      <main className="container margin-vert--lg">
        <h1>FeedBouncer documentation</h1>
        <Link to="/docs/concepts/overview/">Read the docs</Link>
      </main>
    </Layout>
  );
}
