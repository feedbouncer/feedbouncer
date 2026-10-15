'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import {
  MAX_NAME_CHARS,
  MAX_POLICY_CHARS,
  POLICY_ACTIONS,
  POLICY_ACTION_LABEL,
  policyErrorText,
  warningText,
  type PolicyAction,
  type PolicyDto,
} from '../../lib/policies';
import { PreviewRunner } from './preview-runner';

type Props = { orgId: string; brandId: string } & (
  | { mode: 'create' }
  | { mode: 'edit'; policy: PolicyDto }
);

type Issue = { path: string; message: string };

function Problems({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul role="alert">
      {issues.map((i, n) => (
        <li key={n}>{i.message}</li>
      ))}
    </ul>
  );
}

export function PolicyEditor(props: Props) {
  const router = useRouter();
  const policy = props.mode === 'edit' ? props.policy : null;
  const [name, setName] = useState(policy?.name ?? '');
  const [text, setText] = useState(policy?.text ?? '');
  const [action, setAction] = useState<PolicyAction>(policy?.action ?? 'flag');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/policies` as const;
  const pages = `/orgs/${props.orgId}/brands/${props.brandId}/policies`;
  const dirty = !policy || name !== policy.name || text !== policy.text || action !== policy.action;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      if (policy) {
        await apiFetch(`${base}/${policy.id}`, {
          method: 'PATCH',
          body: {
            ...(name !== policy.name && { name }),
            ...(text !== policy.text && { text }),
            ...(action !== policy.action && { action }),
          },
        });
        router.refresh();
      } else {
        const created = await apiFetch<PolicyDto>(base, {
          method: 'POST',
          body: { name, text, action },
        });
        router.push(`${pages}/${created.id}?created=1`);
        router.refresh();
      }
    } catch (err) {
      if (err instanceof ApiRequestError) setIssues(err.issues);
      setError(policyErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={onSubmit}>
        {error ? <p role="alert">{error}</p> : null}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block' }}>
            Name{' '}
            <input
              name="name"
              required
              maxLength={MAX_NAME_CHARS}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <Problems issues={issues.filter((i) => i.path === 'name')} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block' }}>
            Policy{' '}
            <textarea
              name="text"
              required
              rows={4}
              maxLength={MAX_POLICY_CHARS}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <small>
            {Array.from(text).length} / {MAX_POLICY_CHARS}
          </small>
          <Problems issues={issues.filter((i) => i.path === 'text')} />
          {policy && policy.warnings.length > 0 ? (
            <ul role="note">
              {policy.warnings.map((w) => (
                <li key={w}>{warningText(w)}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div style={{ marginBottom: 12 }}>
          <label>
            Action{' '}
            <select
              name="action"
              value={action}
              onChange={(e) => setAction(e.target.value as PolicyAction)}
            >
              {POLICY_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {POLICY_ACTION_LABEL[a]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {action === 'remove' ? (
          <p role="note">
            Delete cannot be undone: deleted comments are removed from the platform.
          </p>
        ) : null}
        {policy ? (
          <p role="note">
            Changing the text or action creates revision {policy.revision + 1}. Past decisions keep
            their revision.
          </p>
        ) : null}
        <button type="submit" disabled={busy || !dirty}>
          {policy ? 'Save policy' : 'Create policy'}
        </button>
      </form>
      {policy ? (
        <PreviewRunner
          orgId={props.orgId}
          brandId={props.brandId}
          policyId={policy.id}
          draft={{ text, action }}
        />
      ) : null}
    </div>
  );
}
