'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '../../lib/api-client';
import {
  POLICY_ACTION_LABEL,
  policyErrorText,
  usageText,
  type PolicyDto,
  type PolicyListDto,
} from '../../lib/policies';

const EXCERPT_CHARS = 100;

const excerpt = (text: string): string => {
  const chars = Array.from(text);
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join('')}…` : text;
};

export function PolicyList(props: {
  orgId: string;
  brandId: string;
  list: PolicyListDto;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { policies, limits, usage, evaluatorConfigured } = props.list;
  const base = `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/policies` as const;
  const pages = `/orgs/${props.orgId}/brands/${props.brandId}/policies`;

  async function run(path: `/api/${string}`, init: Parameters<typeof apiFetch>[1]) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(path, init);
      router.refresh();
    } catch (err) {
      setError(policyErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  function remove(p: PolicyDto) {
    if (!window.confirm('Delete this policy? Past decisions keep showing it.')) return;
    void run(`${base}/${p.id}`, { method: 'DELETE' });
  }

  return (
    <div>
      {evaluatorConfigured ? null : (
        <p role="note">Policy checks are turned off in this deployment.</p>
      )}
      <p>{usageText(usage)}</p>
      {props.canEdit ? (
        <p>
          {policies.length >= limits.maxPolicies ? (
            <span>Limit reached ({limits.maxPolicies})</span>
          ) : (
            <Link href={`${pages}/new`}>New policy</Link>
          )}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {policies.length === 0 ? (
        <p>No policies yet.</p>
      ) : (
        <>
          <p>Up to {limits.maxEnabled} policies can be enabled at once.</p>
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Policy</th>
                <th scope="col">Action</th>
                <th scope="col">Enabled</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                  </td>
                  <td>{excerpt(p.text)}</td>
                  <td>{POLICY_ACTION_LABEL[p.action]}</td>
                  <td>
                    <button
                      type="button"
                      aria-pressed={p.enabled}
                      aria-label={`Enable ${p.name}`}
                      disabled={busy || !props.canEdit}
                      onClick={() =>
                        void run(`${base}/${p.id}`, {
                          method: 'PATCH',
                          body: { enabled: !p.enabled },
                        })
                      }
                    >
                      {p.enabled ? 'On' : 'Off'}
                    </button>
                  </td>
                  <td>
                    <Link href={`${pages}/${p.id}`}>{props.canEdit ? 'Edit' : 'View'}</Link>
                    {props.canEdit ? (
                      <>
                        {' '}
                        <button type="button" disabled={busy} onClick={() => remove(p)}>
                          Delete
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
