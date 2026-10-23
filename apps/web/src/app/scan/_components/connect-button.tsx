'use client';
import { useState } from 'react';
import { apiFetch } from '../../../lib/api-client';
import { safeAuthorizationUrl } from '../../../lib/oauth';

export function ConnectButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function onClick() {
    setBusy(true);
    setError(false);
    try {
      const res = await apiFetch<{ authorizeUrl?: unknown }>('/api/v1/scan/authorize', {
        method: 'POST',
      });
      const url = safeAuthorizationUrl(res.authorizeUrl);
      if (!url) throw new Error('unsafe authorization url');
      window.location.assign(url.href);
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={onClick} disabled={busy}>
        Connect Facebook and scan
      </button>
      {error ? <p role="alert">Could not start the connection. Try again.</p> : null}
    </>
  );
}
