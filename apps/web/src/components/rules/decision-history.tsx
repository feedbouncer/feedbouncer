'use client';
import { useState } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import type { ClassificationView } from '../../lib/classifier';
import { formatUtc } from '../../lib/format';
import { messageFor } from '../../lib/messages';
import { evaluationText, type EvaluationView } from '../../lib/policies';
import type { DecisionView } from '../../lib/rules';
import { PolicyEvidence } from '../policies/policy-evidence';
import { ClassificationSummary } from '../classifier/classification-summary';
import { decisionText } from './decision-badge';

export function DecisionHistory(props: { orgId: string; brandId: string; commentId: string }) {
  const [decisions, setDecisions] = useState<DecisionView[] | null>(null);
  const [classification, setClassification] = useState<ClassificationView | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationView | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (decisions) return setDecisions(null);
    setError(null);
    try {
      const base =
        `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/comments/${props.commentId}` as const;
      const [res, cls, pol] = await Promise.all([
        apiFetch<{ decisions: DecisionView[] }>(`${base}/decisions`),
        apiFetch<{ classification: ClassificationView | null }>(`${base}/classification`),
        apiFetch<EvaluationView | null>(`${base}/policy-evaluation`),
      ]);
      setEvaluation(pol);
      setClassification(cls.classification);
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
      {decisions ? <ClassificationSummary classification={classification} /> : null}
      {decisions &&
      evaluation &&
      (evaluation.status !== 'evaluated' || evaluation.matches.length === 0) ? (
        <p>{evaluationText(evaluation)}</p>
      ) : null}
      {decisions ? (
        decisions.length === 0 ? (
          <p>No decisions yet.</p>
        ) : (
          <ul>
            {decisions.map((d) => (
              <li key={d.id}>
                {decisionText(d)}
                {d.fallback ? null : `: ${d.reason}`} ({formatUtc(d.createdAt)})
                {d.policy ? <PolicyEvidence policy={d.policy} /> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
