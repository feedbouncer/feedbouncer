'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '../lib/api-client';
import { messageFor, outcomeText } from '../lib/messages';
import { ConnectButton } from './connect-button';

export interface PageAccount {
  externalAccountId: string;
  displayName: string | null;
  eligible: boolean;
  limitations: string[];
  connection: 'this_brand' | 'elsewhere' | null;
}

interface ConnectResult {
  externalAccountId: string;
  status: string;
}

function note(a: PageAccount): string | null {
  if (!a.eligible) return 'You need a role that can moderate this Page';
  if (a.connection === 'elsewhere') return 'Already connected in another FeedBouncer workspace';
  if (a.connection === 'this_brand') return 'Connected; selecting it refreshes access';
  if (a.limitations.includes('no_messaging_task')) return "Private replies won't be available";
  return null;
}

function resultText(status: string): string {
  if (status === 'connected') return 'Connected';
  if (status === 'reconnected') return 'Reconnected';
  return `Not connected: ${outcomeText(status)}`;
}

export function PagePicker(props: {
  orgId: string;
  brandId: string;
  grantId: string;
  accounts: PageAccount[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [results, setResults] = useState<ConnectResult[] | null>(null);
  const connectionsHref = `/orgs/${props.orgId}/brands/${props.brandId}/connections`;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const pageIds = new FormData(e.currentTarget).getAll('pageId').map(String);
    if (pageIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ results: ConnectResult[] }>(
        `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/connections/facebook/grants/${props.grantId}/connect`,
        { method: 'POST', body: { pageIds } },
      );
      setResults(res.results);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) setExpired(true);
      else
        setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <>
        <p role="alert">This sign-in has expired. Connect again.</p>
        <ConnectButton orgId={props.orgId} brandId={props.brandId} label="Connect Facebook Page" />
      </>
    );
  }

  if (results) {
    const names = new Map(props.accounts.map((a) => [a.externalAccountId, a.displayName]));
    return (
      <>
        <ul>
          {results.map((r) => (
            <li key={r.externalAccountId}>
              {names.get(r.externalAccountId) ?? r.externalAccountId}: {resultText(r.status)}
            </li>
          ))}
        </ul>
        <p>
          <Link href={connectionsHref}>Back to connections</Link>
        </p>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <ul>
        {props.accounts.map((a) => {
          const disabled = !a.eligible || a.connection === 'elsewhere';
          const text = note(a);
          return (
            <li key={a.externalAccountId}>
              <label>
                <input
                  type="checkbox"
                  name="pageId"
                  value={a.externalAccountId}
                  disabled={disabled}
                />{' '}
                {a.displayName ?? 'Unnamed Page'} ({a.externalAccountId})
              </label>
              {text ? <small> {text}</small> : null}
            </li>
          );
        })}
      </ul>
      <button type="submit" disabled={busy}>
        Connect selected Pages
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
