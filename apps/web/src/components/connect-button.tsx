'use client';
import { useState } from 'react';
import { ApiRequestError, apiFetch } from '../lib/api-client';
import { messageFor } from '../lib/messages';
import { safeAuthorizationUrl } from '../lib/oauth';
import type { ConnectablePlatform } from '../lib/platforms';

export function ConnectButton(props: {
  orgId: string;
  brandId: string;
  platform: ConnectablePlatform;
  label: string;
  reconnectConnectionId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ authorizationUrl?: unknown }>(
        `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/connections/${props.platform}/authorize`,
        {
          method: 'POST',
          body: props.reconnectConnectionId
            ? { reconnectConnectionId: props.reconnectConnectionId }
            : {},
        },
      );
      const url = safeAuthorizationUrl(res.authorizationUrl);
      if (!url) throw new Error('unsafe authorization url');
      window.location.assign(url.href);
    } catch (err) {
      // An unconfigured platform answers 404 platform_not_configured, shown as such.
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={onClick} disabled={busy}>
        {props.label}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
