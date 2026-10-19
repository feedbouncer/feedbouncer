'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { apiFetch } from '../../lib/api-client';
import {
  ACCESS_OPTIONS,
  accessText,
  apiKeyErrorText,
  copyToken,
  lastUsedText,
  revokeConfirmText,
  statusText,
  type ApiKeyDto,
} from '../../lib/api-keys';
import { formatUtc } from '../../lib/format';

/** The created token lives only in this component's state: never in the URL, storage or logs. */
export function ApiKeyManager({ orgId, items }: { orgId: string; items: ApiKeyDto[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const base = `/api/v1/orgs/${orgId}/api-keys` as const;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (err) {
      setError(apiKeyErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      const created = await apiFetch<{ token: string }>(base, {
        method: 'POST',
        body: { name: String(data.get('name') ?? ''), scope: String(data.get('scope') ?? '') },
      });
      setToken(created.token);
      setCopyNote(null);
      form.reset();
    });
  }

  function onRevoke(key: ApiKeyDto) {
    if (!window.confirm(revokeConfirmText(key.name))) return;
    void run(async () => {
      await apiFetch(`${base}/${key.id}/revoke`, { method: 'POST' });
    });
  }

  return (
    <>
      <form onSubmit={onCreate}>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Name <input name="name" type="text" maxLength={100} required />
        </label>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Access{' '}
          <select name="scope" defaultValue="read">
            {ACCESS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Create key
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {token ? (
        <section role="status">
          <p>Copy this key now. You won&apos;t be able to see it again.</p>
          <p>
            <code>{token}</code>{' '}
            <button
              type="button"
              onClick={() =>
                void copyToken((t) => navigator.clipboard.writeText(t), token).then(setCopyNote)
              }
            >
              Copy
            </button>
          </p>
          {copyNote ? <p>{copyNote}</p> : null}
        </section>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Access</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td>
                <code>{k.prefix}…</code>
              </td>
              <td>{accessText(k.scope)}</td>
              <td>{formatUtc(k.createdAt)}</td>
              <td>{lastUsedText(k.lastUsedAt)}</td>
              <td>{statusText(k.status)}</td>
              <td>
                {k.status === 'active' ? (
                  <button type="button" disabled={busy} onClick={() => onRevoke(k)}>
                    Revoke
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
