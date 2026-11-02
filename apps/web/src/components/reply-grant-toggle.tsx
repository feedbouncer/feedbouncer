'use client';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ApiRequestError, apiFetch } from '../lib/api-client';
import { messageFor } from '../lib/messages';

export function ReplyGrantToggle(props: { orgId: string; granted: boolean; canChange: boolean }) {
  const id = useId();
  const router = useRouter();
  const [granted, setGranted] = useState(props.granted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChange(next: boolean) {
    const previous = granted;
    setGranted(next);
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/orgs/${props.orgId}/role-grants`, {
        method: 'PUT',
        body: { role: 'member', capability: 'comment.reply', granted: next },
      });
      router.refresh();
    } catch (err) {
      setGranted(previous);
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 font-normal text-foreground">
        <input
          type="checkbox"
          checked={granted}
          disabled={!props.canChange || busy}
          aria-describedby={`${id}-help`}
          onChange={(e) => void onChange(e.target.checked)}
        />
        Members can reply to comments
      </label>
      <p id={`${id}-help`} className="text-small text-dim">
        Owners and admins can always reply.
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
