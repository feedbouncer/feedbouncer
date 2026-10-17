'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { apiFetch } from '../../lib/api-client';

const OUTCOMES = {
  unsubscribed:
    "You won't get this workspace's weekly report email anymore. You can turn it back on in your account settings.",
  already: 'You were already unsubscribed from this weekly report email.',
  invalid: 'This link is invalid. Manage weekly report emails in your account settings.',
} as const;
type Outcome = keyof typeof OUTCOMES;

const Result = ({ outcome }: { outcome: Outcome }) => (
  <p role={outcome === 'invalid' ? 'alert' : 'status'}>
    {OUTCOMES[outcome]} <Link href="/account#email-reports">Email settings</Link>
  </p>
);

/**
 * Nothing is sent until the button is pressed, so link scanners that only GET the page cannot
 * unsubscribe anyone. Without script the form is the RFC 8058 one-click POST. A null token
 * (a malformed link) shows the invalid state and never sends anything.
 */
export function ReportUnsubscribe({ token }: { token: string | null }) {
  const [state, setState] = useState<'idle' | 'busy' | 'error' | Outcome>('idle');
  if (token === null) return <Result outcome="invalid" />;
  if (state === 'unsubscribed' || state === 'already' || state === 'invalid')
    return <Result outcome={state} />;
  const action =
    `/api/v1/report-subscriptions/unsubscribe?token=${encodeURIComponent(token)}` as const;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState('busy');
    try {
      const r = await apiFetch<{ status: 'unsubscribed' | 'already' | 'invalid' }>(action, {
        method: 'POST',
      });
      setState(r.status);
    } catch {
      setState('error');
    }
  }

  return (
    <form method="post" action={action} onSubmit={onSubmit}>
      <input type="hidden" name="List-Unsubscribe" value="One-Click" />
      <button type="submit" disabled={state === 'busy'}>
        Unsubscribe
      </button>
      {state === 'error' ? <p role="alert">Something went wrong. Try again.</p> : null}
    </form>
  );
}
