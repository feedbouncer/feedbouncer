import Link from 'next/link';
import { redirect } from 'next/navigation';
import { StandaloneShell } from '../components/shell/standalone-shell';
import { buttonVariants } from '../components/ui/button';
import { apiInternalUrl } from '../lib/api-url';
import { serverGet, type Me } from '../lib/server-api';
import { loadSignupEnabled } from '../lib/signup';

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
  const [status, me, signupEnabled] = await Promise.all([
    apiStatus(),
    serverGet<Me>('/api/v1/me'),
    loadSignupEnabled(),
  ]);
  if (me.status === 200 && me.data) redirect('/orgs');

  return (
    <StandaloneShell>
      <main>
        <div className="flex flex-col gap-3">
          <h1>FeedBouncer</h1>
          <p className="text-dim max-w-prose">
            Automatic comment moderation for your social accounts &mdash; review, hide and reply
            without digging through every post yourself.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {signupEnabled && (
            <Link href="/sign-up" className={buttonVariants()}>
              Sign up
            </Link>
          )}
          <Link href="/login" className={buttonVariants({ variant: 'secondary' })}>
            Log in
          </Link>
        </div>
        <p className="text-small text-faint">
          API: <strong data-testid="api-status">{status}</strong>
        </p>
      </main>
    </StandaloneShell>
  );
}
