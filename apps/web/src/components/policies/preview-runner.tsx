'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api-client';
import { plural, policyErrorText, type PolicyAction, type PreviewView } from '../../lib/policies';
import { PolicyPreview } from './policy-preview';

const DAYS = [1, 3, 7, 14] as const;
const POLL_MS = 2000;

/** Runs the policy's current draft against recent comments and shows the result as it arrives. */
export function PreviewRunner(props: {
  orgId: string;
  brandId: string;
  policyId: string;
  draft: { text: string; action: PolicyAction };
}) {
  const [days, setDays] = useState<number>(7);
  const [view, setView] = useState<PreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/v1/orgs/${props.orgId}/brands/${props.brandId}` as const;
  const running = view?.status === 'running';
  const previewId = view?.id;

  useEffect(() => {
    if (!running || !previewId) return;
    const timer = setTimeout(() => {
      apiFetch<PreviewView>(`${base}/policy-previews/${previewId}`)
        .then(setView)
        .catch((err: unknown) => {
          setError(policyErrorText(err));
          setView(null);
        });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [base, running, previewId, view]);

  async function start() {
    setBusy(true);
    setError(null);
    setView(null);
    try {
      const { id } = await apiFetch<{ id: string }>(`${base}/policy-previews`, {
        method: 'POST',
        body: { ...props.draft, days, policyId: props.policyId },
      });
      setView(await apiFetch<PreviewView>(`${base}/policy-previews/${id}`));
    } catch (err) {
      setError(policyErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Preview this policy">
      <h2>Preview</h2>
      <p>Check the draft above against recent comments before enabling it.</p>
      <label>
        Look back{' '}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {plural(d, 'day')}
            </option>
          ))}
        </select>
      </label>{' '}
      <button type="button" disabled={busy || running} onClick={() => void start()}>
        Run preview
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <div aria-live="polite">{view ? <PolicyPreview view={view} /> : null}</div>
    </section>
  );
}
