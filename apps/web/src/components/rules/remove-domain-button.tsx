'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';

export function RemoveDomainButton(props: { orgId: string; brandId: string; domainId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(
        `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/domains/${props.domainId}`,
        { method: 'DELETE' },
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" disabled={busy} onClick={remove}>
        Remove
      </button>
      {error ? <span role="alert"> {error}</span> : null}
    </>
  );
}
