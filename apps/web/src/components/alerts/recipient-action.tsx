'use client';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';

export const RECIPIENT_COPY = {
  confirm: {
    button: 'Confirm alerts',
    success: "You'll now receive FeedBouncer alerts.",
    invalid:
      'This confirmation link is invalid or has expired. Ask a workspace admin to resend it.',
  },
  unsubscribe: {
    button: 'Unsubscribe',
    success: "You're unsubscribed from these alerts.",
    invalid: 'This link is invalid. Manage alerts in FeedBouncer.',
  },
} as const;

type Kind = keyof typeof RECIPIENT_COPY;

export const RECIPIENT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function actionUrl(kind: Kind, token: string): `/api/${string}` {
  return kind === 'confirm'
    ? '/api/v1/alert-recipients/confirm'
    : `/api/v1/alert-recipients/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Nothing is sent until the button is pressed, so link scanners that only GET the page cannot
 * confirm or unsubscribe anyone. Without script the unsubscribe form still works as the
 * RFC 8058 one-click POST; confirm needs script because the API takes JSON.
 */
export function RecipientAction({ kind, token }: { kind: Kind; token: string }) {
  const copy = RECIPIENT_COPY[kind];
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'invalid' | 'error'>('idle');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState('busy');
    try {
      await apiFetch(actionUrl(kind, token), { method: 'POST', body: { token } });
      setState('done');
    } catch (err) {
      setState(err instanceof ApiRequestError && err.status === 404 ? 'invalid' : 'error');
    }
  }

  if (state === 'done') return <p role="status">{copy.success}</p>;
  if (state === 'invalid') return <p role="alert">{copy.invalid}</p>;
  return (
    <form method="post" action={actionUrl(kind, token)} onSubmit={onSubmit}>
      {kind === 'confirm' ? <input type="hidden" name="token" value={token} /> : null}
      {kind === 'unsubscribe' ? (
        <input type="hidden" name="List-Unsubscribe" value="One-Click" />
      ) : null}
      <button type="submit" disabled={state === 'busy'}>
        {copy.button}
      </button>
      {state === 'error' ? <p role="alert">Something went wrong. Try again.</p> : null}
    </form>
  );
}
