'use client';
import { useState } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { formatUtc } from '../../lib/format';
import { messageFor } from '../../lib/messages';
import type { DecisionView } from '../../lib/rules';
import { decisionText } from './decision-badge';

export function DecisionHistory(props: { orgId: string; brandId: string; commentId: string }) {
  const [decisions, setDecisions] = useState<DecisionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (decisions) return setDecisions(null);
    setError(null);
    try {
      const res = await apiFetch<{ decisions: DecisionView[] }>(
        `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/comments/${props.commentId}/decisions`,
      );
      setDecisions(res.decisions);
    } catch (err) {
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    }
  }

  return (
    <div>
      <button type="button" onClick={toggle}>
        {decisions ? 'Hide reasons' : 'Why?'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {decisions ? (
        decisions.length === 0 ? (
          <p>No decisions yet.</p>
        ) : (
          <ul>
            {decisions.map((d) => (
              <li key={d.id}>{`${decisionText(d)}: ${d.reason} (${formatUtc(d.createdAt)})`}</li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
