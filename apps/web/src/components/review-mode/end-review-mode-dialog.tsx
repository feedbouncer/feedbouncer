'use client';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import type { BrandApiBase } from '../../lib/actions';
import { ApiRequestError } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';
import {
  END_CHOICES,
  endReviewMode,
  endReviewModeBody,
  type EndChoice,
} from '../../lib/review-mode';

export function EndReviewModeDialog(props: {
  orgId: string;
  brandId: string;
  connectionId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const id = useId();
  const [choice, setChoice] = useState<EndChoice>('leave');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = endReviewModeBody(choice, confirmed);
  const base =
    `/api/v1/orgs/${props.orgId}/brands/${props.brandId}` as const satisfies BrandApiBase;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await endReviewMode(base, props.connectionId, body);
      props.onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      className="rounded-lg border border-border bg-card p-(--fb-card-pad)"
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend id={`${id}-title`} className="mb-2">
            End review mode now? What should happen to the waiting suggestions?
          </legend>
          {END_CHOICES.map((c) => (
            <label key={c.value} className="flex items-center gap-2 font-normal text-foreground">
              <input
                type="radio"
                name="pending"
                value={c.value}
                checked={choice === c.value}
                onChange={() => setChoice(c.value)}
              />
              {c.label}
            </label>
          ))}
          <label className="flex items-center gap-2 font-normal text-foreground">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={choice !== 'approve'}
              onChange={(e) => setConfirmed(e.currentTarget.checked)}
            />
            I understand this runs every suggested action now.
          </label>
        </fieldset>
        <div className="flex gap-2">
          <button type="submit" className="btn-primary btn-sm" disabled={busy || body === null}>
            End review mode
          </button>
          <button type="button" className="btn-sm" onClick={props.onClose}>
            Cancel
          </button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </div>
  );
}
