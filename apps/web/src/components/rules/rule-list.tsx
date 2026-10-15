'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';
import { ACTION_LABEL, KIND_LABEL, type RuleView } from '../../lib/rules';

function isTrustedAuthorList(r: RuleView): boolean {
  const c = r.conditions as { type?: unknown; list?: unknown } | null;
  return r.kind === 'author' && c?.type === 'author' && c.list === 'trusted';
}

export function RuleList(props: { orgId: string; brandId: string; rules: RuleView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/rules` as const;
  const pages = `/orgs/${props.orgId}/brands/${props.brandId}/rules`;

  async function run(path: `/api/${string}`, init: Parameters<typeof apiFetch>[1]) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(path, init);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, by: -1 | 1) {
    const ids = props.rules.map((r) => r.id);
    const a = ids[index];
    const b = ids[index + by];
    if (a === undefined || b === undefined) return;
    ids[index] = b;
    ids[index + by] = a;
    void run(`${base}/order`, { method: 'PUT', body: { ruleIds: ids } });
  }

  function remove(rule: RuleView) {
    if (!window.confirm('Delete rule? Its past decisions stay visible.')) return;
    void run(`${base}/${rule.id}`, { method: 'DELETE' });
  }

  if (props.rules.length === 0) return <p>No rules yet.</p>;
  const last = props.rules.length - 1;
  return (
    <div>
      {error ? <p role="alert">{error}</p> : null}
      <table>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Action</th>
            <th scope="col">Mode</th>
            <th scope="col">Enabled</th>
            <th scope="col">Order</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {props.rules.map((r, i) => (
            <tr key={r.id}>
              <td>{r.position}</td>
              <td>
                <strong>{r.name}</strong>
                {isTrustedAuthorList(r) ? <div>Always checked first</div> : null}
                {r.warnings.shadowedBy ? (
                  <div role="note">{`Never fires: '${r.warnings.shadowedBy.name}' above always matches first`}</div>
                ) : null}
                {r.warnings.neverMatches ? (
                  <div role="note">Never matches: the list is empty</div>
                ) : null}
                {r.warnings.invalid ? (
                  <div role="note">
                    This rule has an old format and is skipped. Edit and save it to fix it.
                  </div>
                ) : null}
              </td>
              <td>{r.kind ? KIND_LABEL[r.kind] : 'Unknown'}</td>
              <td>{ACTION_LABEL[r.action]}</td>
              <td>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(`${base}/${r.id}`, {
                      method: 'PATCH',
                      body: { mode: r.mode === 'enforce' ? 'suggest' : 'enforce' },
                    })
                  }
                >
                  {r.mode === 'enforce' ? 'Active' : 'Dry run'}
                </button>
              </td>
              <td>
                <label>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={busy}
                    aria-label={`Enable ${r.name}`}
                    onChange={() =>
                      void run(`${base}/${r.id}`, {
                        method: 'PATCH',
                        body: { enabled: !r.enabled },
                      })
                    }
                  />
                </label>
              </td>
              <td>
                {i > 0 ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Move ${r.name} up`}
                    onClick={() => move(i, -1)}
                  >
                    ▲
                  </button>
                ) : null}
                {i < last ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Move ${r.name} down`}
                    onClick={() => move(i, 1)}
                  >
                    ▼
                  </button>
                ) : null}
              </td>
              <td>
                <Link href={`${pages}/${r.id}`}>Edit</Link>{' '}
                <button type="button" disabled={busy} onClick={() => remove(r)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
