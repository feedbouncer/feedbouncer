import Link from 'next/link';
import { apiInternalUrl } from '../lib/api-url';

export const dynamic = 'force-dynamic';

type ApiStatus = 'up' | 'down' | 'not configured';

async function apiStatus(): Promise<ApiStatus> {
  const base = apiInternalUrl();
  if (!base) return 'not configured';
  try {
    const res = await fetch(new URL('/healthz', base), {
      cache: 'no-store',
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

export default async function Home() {
  const status = await apiStatus();
  return (
    <main>
      <h1>FeedBouncer</h1>
      <p>
        Local development stack. API: <strong data-testid="api-status">{status}</strong>
      </p>
      <nav>
        <Link href="/login">Log in</Link> · <Link href="/sign-up">Sign up</Link> ·{' '}
        <Link href="/orgs">My organizations</Link>
      </nav>
    </main>
  );
}
