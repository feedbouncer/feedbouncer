'use client';
import { useState } from 'react';
import { apiFetch } from '../../lib/api-client';
import { plural, policyErrorText } from '../../lib/policies';

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function ApplyRecent(props: { orgId: string; brandId: string; policyId: string }) {
  const [days, setDays] = useState<number>(7);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    const span = plural(days, 'day');
    if (
      !window.confirm(
        `Check comments from the last ${span} against this policy and take its action on matches? Comments a moderator already acted on are only flagged.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const run = await apiFetch<{ id: string; connections: number }>(
        `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/policies/${props.policyId}/runs`,
        { method: 'POST', body: { days } },
      );
      setNotice(`Started on ${plural(run.connections, 'connection')}.`);
    } catch (err) {
      setError(policyErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Apply to recent comments">
      <h2>Apply to recent comments</h2>
      <p>Enabling a policy only affects new comments. Apply it to older ones explicitly.</p>
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
      <button type="button" disabled={busy} onClick={() => void apply()}>
        Apply to recent comments
      </button>
      <div aria-live="polite">{notice ? <p>{notice}</p> : null}</div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
