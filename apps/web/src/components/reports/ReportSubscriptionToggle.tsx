'use client';
import { useState } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';

/** One workspace's weekly report email on or off, for the signed-in owner or admin. */
export function ReportSubscriptionToggle(props: {
  orgId: string;
  orgName: string;
  subscribed: boolean;
}) {
  const [subscribed, setSubscribed] = useState(props.subscribed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChange(next: boolean) {
    setSubscribed(next);
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/me/report-subscriptions/${props.orgId}`, {
        method: 'PUT',
        body: { subscribed: next },
      });
    } catch (err) {
      setSubscribed(!next);
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={subscribed}
          disabled={busy}
          onChange={(e) => void onChange(e.target.checked)}
        />{' '}
        {`Weekly report for ${props.orgName}`}
      </label>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
