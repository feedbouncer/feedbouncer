'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  POLL_LIMIT,
  POLL_MS,
  STEP_LABEL,
  STEP_ORDER,
  STEP_STATUSES,
  hasPending,
  outcomeText,
  undoLogStep,
  undoText,
  type BrandApiBase,
  type LogEntryView,
} from '../../lib/actions';
import { ApiRequestError } from '../../lib/api-client';
import { formatUtc } from '../../lib/format';
import { messageFor } from '../../lib/messages';

export interface LogFilters {
  ruleId?: string;
  status?: string;
  type?: string;
}

const STATUS_NAME: Record<(typeof STEP_STATUSES)[number], string> = {
  pending: 'Waiting to run',
  succeeded: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  not_applicable: 'Not applicable',
  not_supported: 'Not supported',
  simulated: 'Dry run',
};

export function ActionLog(props: {
  orgId: string;
  brandId: string;
  entries: LogEntryView[];
  rules: { id: string; name: string }[];
  filters: LogFilters;
  next: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base =
    `/api/v1/orgs/${props.orgId}/brands/${props.brandId}` as const satisfies BrandApiBase;
  const page = `/orgs/${props.orgId}/brands/${props.brandId}/actions`;
  const pending = hasPending(props.entries);

  // Pending steps are finished by a worker; look again until they are, a bounded number of times.
  useEffect(() => {
    if (!pending) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (tries > POLL_LIMIT) clearInterval(timer);
      else router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, router]);

  async function undo(stepId: string) {
    setBusy(stepId);
    setError(null);
    try {
      await undoLogStep(base, stepId);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  const more = new URLSearchParams(Object.entries(props.filters));
  if (props.next) more.set('before', props.next);

  return (
    <div>
      <form method="get">
        <label>
          Rule{' '}
          <select name="ruleId" defaultValue={props.filters.ruleId ?? ''}>
            <option value="">All</option>
            {props.rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Outcome{' '}
          <select name="status" defaultValue={props.filters.status ?? ''}>
            <option value="">All</option>
            {STEP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_NAME[s]}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Step{' '}
          <select name="type" defaultValue={props.filters.type ?? ''}>
            <option value="">All</option>
            {STEP_ORDER.map((t) => (
              <option key={t} value={t}>
                {STEP_LABEL[t]}
              </option>
            ))}
          </select>
        </label>{' '}
        <button type="submit">Filter</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {props.entries.length === 0 ? <p>No actions yet.</p> : null}
      {props.entries.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Comment</th>
              <th scope="col">Rule</th>
              <th scope="col">Step</th>
              <th scope="col">Outcome</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {props.entries.map((e) => {
              const undone = undoText(e);
              const undoLabel = undone ? 'Retry undo' : 'Undo';
              return (
                <tr key={e.id}>
                  <td>{formatUtc(e.createdAt)}</td>
                  <td>
                    <Link
                      href={`/orgs/${props.orgId}/brands/${props.brandId}/comments#comment-${e.commentId}`}
                    >
                      View comment
                    </Link>
                  </td>
                  <td>{e.ruleName}</td>
                  <td>{STEP_LABEL[e.type]}</td>
                  <td>
                    {outcomeText(e.status, e.reasonCode)}
                    {undone ? <small>{` (${undone})`}</small> : null}
                  </td>
                  <td>
                    {e.undoable ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        aria-label={`${undoLabel} ${STEP_LABEL[e.type]}`}
                        onClick={() => void undo(e.id)}
                      >
                        {undoLabel}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {props.next ? (
        <p>
          <Link href={`${page}?${more.toString()}`}>Load more</Link>
        </p>
      ) : null}
    </div>
  );
}
