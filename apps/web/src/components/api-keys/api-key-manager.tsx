'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { TableScroll } from '../states';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { apiFetch } from '../../lib/api-client';
import {
  ACCESS_HELP,
  ACCESS_OPTIONS,
  accessText,
  apiKeyErrorText,
  copyToken,
  lastUsedText,
  revokeConfirmText,
  statusText,
  type ApiKeyDto,
  type ApiKeyScope,
} from '../../lib/api-keys';
import { formatUtc } from '../../lib/format';

/** The created token lives only in this component's state: never in the URL, storage or logs. */
export function ApiKeyManager({ orgId, items }: { orgId: string; items: ApiKeyDto[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [scope, setScope] = useState<ApiKeyScope>('read');
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
      setScope('read');
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
      <Card>
        <CardHeader>
          <CardTitle>Create a key</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="flex max-w-form flex-col gap-(--fb-form-gap)">
            <label className="flex flex-col gap-(--fb-field-gap)">
              Name
              <input name="name" type="text" maxLength={100} required />
            </label>
            <label className="flex flex-col gap-(--fb-field-gap)">
              Access
              <select
                name="scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as ApiKeyScope)}
              >
                {ACCESS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {ACCESS_HELP[scope] ? <p className="text-small text-dim">{ACCESS_HELP[scope]}</p> : null}
            <button type="submit" className="btn-primary" disabled={busy}>
              Create key
            </button>
          </form>
          {error ? <p role="alert">{error}</p> : null}
          {token ? (
            <section role="status" className="mt-4 flex flex-col gap-2">
              <p className="font-semibold text-foreground">
                Copy this key now. You won&apos;t be able to see it again.
              </p>
              <div className="flex items-center gap-2">
                <code className="rounded-md border border-border bg-elevated px-3 py-2 text-small">
                  {token}
                </code>
                <button
                  type="button"
                  className="btn-sm"
                  onClick={() =>
                    void copyToken((t) => navigator.clipboard.writeText(t), token).then(setCopyNote)
                  }
                >
                  Copy
                </button>
              </div>
              {copyNote ? <p className="text-small text-dim">{copyNote}</p> : null}
            </section>
          ) : null}
        </CardContent>
      </Card>
      <TableScroll>
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
                    <button
                      type="button"
                      className="btn-destructive btn-sm"
                      disabled={busy}
                      onClick={() => onRevoke(k)}
                    >
                      Revoke
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </>
  );
}
