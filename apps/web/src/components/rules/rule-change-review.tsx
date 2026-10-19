'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatUtc } from '../../lib/format';
import {
  STALE_TEXT,
  decideRuleChange,
  valueText,
  type RuleChangeView,
} from '../../lib/rule-changes';

const OPERATION_LABEL = {
  create: 'New rule',
  update: 'Rule edit',
  archive: 'Rule removal',
} as const;

export function RuleChangeReview(props: {
  orgId: string;
  brandId: string;
  change: RuleChangeView;
  canDecide: boolean;
}) {
  const { change } = props;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    const message = await decideRuleChange(decision, props.orgId, props.brandId, change.id);
    setBusy(false);
    if (message) setError(message);
    else router.refresh();
  }

  return (
    <section>
      <p>
        {OPERATION_LABEL[change.operation]} proposed by {change.proposedBy.apiKeyName} · Status:{' '}
        {change.status}
      </p>
      {change.isStale || change.status === 'stale' ? <p role="alert">{STALE_TEXT}</p> : null}
      <table>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {change.diff.map((d) => (
            <tr key={d.field}>
              <th scope="row">{d.field}</th>
              <td>{valueText(d.before)}</td>
              <td>{valueText(d.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {change.warnings.map((w) => (
        <p key={w} role="note">
          {w}
        </p>
      ))}
      <h2>Reason given by the API client (not verified)</h2>
      <p>{change.rationale ?? 'No reason given.'}</p>
      <p>Expires {formatUtc(change.expiresAt)}</p>
      {change.decidedAt ? (
        <p>
          Decided by {change.decidedBy?.name ?? 'a former member'} at {formatUtc(change.decidedAt)}
          {change.decisionNote ? `: ${change.decisionNote}` : ''}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {/* A stale proposal can't be approved, but rejecting it clears it from the pending list. */}
      {props.canDecide && change.status === 'pending' ? (
        <p>
          {change.isStale ? null : (
            <>
              <button type="button" disabled={busy} onClick={() => void decide('approve')}>
                Approve
              </button>{' '}
            </>
          )}
          <button type="button" disabled={busy} onClick={() => void decide('reject')}>
            Reject
          </button>
        </p>
      ) : null}
    </section>
  );
}
