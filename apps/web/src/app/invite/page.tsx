'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';

interface Lookup {
  organizationName: string;
  role: string;
  emailMatches: boolean;
}

type View =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'ready'; invite: Lookup };

function Invite() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setView({ kind: 'error', text: 'This invitation is invalid, expired or already used.' });
      return;
    }
    apiFetch<Lookup>('/api/v1/invitations/lookup', { method: 'POST', body: { token } }).then(
      (invite) => setView({ kind: 'ready', invite }),
      (err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`);
        } else if (err instanceof ApiRequestError && err.status === 404) {
          setView({
            kind: 'error',
            text: 'This invitation is invalid, expired or already used.',
          });
        } else {
          setView({
            kind: 'error',
            text: err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.',
          });
        }
      },
    );
  }, [token, router]);

  async function accept() {
    setError(null);
    try {
      const r = await apiFetch<{ organizationId: string }>('/api/v1/invitations/accept', {
        method: 'POST',
        body: { token },
      });
      router.push(`/orgs/${r.organizationId}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    }
  }

  if (view.kind === 'loading') return <p>Loading invitation...</p>;
  if (view.kind === 'error') return <p role="alert">{view.text}</p>;
  if (!view.invite.emailMatches) {
    return (
      <p role="alert">
        This invitation was sent to a different email address. Log in with that address.{' '}
        <Link href="/login">Log in</Link>
      </p>
    );
  }
  return (
    <section>
      <p>
        Join {view.invite.organizationName} as {view.invite.role}
      </p>
      <button type="button" onClick={accept}>
        Accept
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

export default function InvitePage() {
  return (
    <main>
      <h1>Invitation</h1>
      <Suspense fallback={<p>Loading invitation...</p>}>
        <Invite />
      </Suspense>
    </main>
  );
}
