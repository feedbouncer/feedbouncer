'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';
import { browserTimezone } from '../../lib/timezone';

/** Tells the viewer that "today" for a brand still uses UTC midnight, and lets a manager fix it. */
export function TimezoneNotice(props: {
  orgId: string;
  brandId: string;
  brandName: string;
  canManage: boolean;
}) {
  const router = useRouter();
  // The server cannot know the viewer's zone, so the label settles after hydration.
  const [zone, setZone] = useState('your timezone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setZone(browserTimezone()), []);

  async function use() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/orgs/${props.orgId}/brands/${props.brandId}`, {
        method: 'PATCH',
        body: { timezone: browserTimezone() },
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p>
        {`"Today" for ${props.brandName} uses UTC midnight. Set this brand's timezone`}
        {props.canManage ? (
          <>
            {': '}
            <button type="button" disabled={busy} onClick={() => void use()}>
              {`Use ${zone}`}
            </button>
          </>
        ) : (
          '. Ask an admin to set it.'
        )}
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
