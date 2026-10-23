'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '../../../lib/api-client';

export function ShareControls({ scanId, shared }: { scanId: string; shared: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [isShared, setShared] = useState(shared);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, failure: string) {
    setError(null);
    try {
      await action();
    } catch {
      setError(failure);
    }
  }

  const share = () =>
    run(async () => {
      const res = await apiFetch<{ shareUrl: string }>(`/api/v1/scan/scans/${scanId}/share`, {
        method: 'PUT',
      });
      setUrl(res.shareUrl);
      setShared(true);
    }, 'Could not create a link. Try again.');

  const unshare = () =>
    run(async () => {
      await apiFetch(`/api/v1/scan/scans/${scanId}/share`, { method: 'DELETE' });
      setUrl(null);
      setShared(false);
    }, 'Could not stop sharing. Try again.');

  const remove = () =>
    run(async () => {
      await apiFetch(`/api/v1/scan/scans/${scanId}`, { method: 'DELETE' });
      router.push('/scan');
    }, 'Could not delete this result. Try again.');

  return (
    <section>
      <h2>Share or delete</h2>
      <button type="button" onClick={share}>
        {isShared ? 'Create a new link' : 'Create a share link'}
      </button>{' '}
      {isShared ? (
        <button type="button" onClick={unshare}>
          Stop sharing
        </button>
      ) : null}{' '}
      <button type="button" onClick={remove}>
        Delete this result
      </button>
      {url ? (
        <p>
          Anyone with this link can see the result, without comment authors:{' '}
          <input readOnly value={url} aria-label="Share link" size={60} />
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
