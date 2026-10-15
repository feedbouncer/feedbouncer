'use client';
import { useState } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import type { ClassificationView } from '../../lib/classifier';
import { formatUtc } from '../../lib/format';
import { messageFor } from '../../lib/messages';
import type { DecisionView } from '../../lib/rules';
import { ClassificationSummary } from '../classifier/classification-summary';
import { decisionText } from './decision-badge';

export function DecisionHistory(props: { orgId: string; brandId: string; commentId: string }) {
  const [decisions, setDecisions] = useState<DecisionView[] | null>(null);
  const [classification, setClassification] = useState<ClassificationView | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (decisions) return setDecisions(null);
    setError(null);
    try {
      const base =
        `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/comments/${props.commentId}` as const;
      const [res, cls] = await Promise.allSettled([
        apiFetch<{ decisions: DecisionView[] }>(`${base}/decisions`),
        apiFetch<{ classification: ClassificationView | null }>(`${base}/classification`),
      ]);
      if (res.status === 'rejected') throw res.reason;
      setClassification(cls.status === 'fulfilled' ? cls.value.classification : null);
      setDecisions(res.value.decisions);
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
      {decisions ? <ClassificationSummary classification={classification} /> : null}
      {decisions ? (
        decisions.length === 0 ? (
          <p>No decisions yet.</p>
        ) : (
          <ul>
            {decisions.map((d) => (
              <li key={d.id}>
                {decisionText(d)}
                {d.fallback ? null : `: ${d.reason}`} ({formatUtc(d.createdAt)})
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
