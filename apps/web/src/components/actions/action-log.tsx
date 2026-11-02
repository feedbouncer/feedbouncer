'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { TableScroll } from '../states';
import {
  POLL_LIMIT,
  POLL_MS,
  STEP_LABEL,
  STEP_ORDER,
  STATUS_LABEL,
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
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card p-(--fb-card-pad)">
        <form method="get" className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-(--fb-field-gap)">
            Rule
            <select name="ruleId" defaultValue={props.filters.ruleId ?? ''}>
              <option value="">All</option>
              {props.rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-(--fb-field-gap)">
            Outcome
            <select name="status" defaultValue={props.filters.status ?? ''}>
              <option value="">All</option>
              {STEP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-(--fb-field-gap)">
            Step
            <select name="type" defaultValue={props.filters.type ?? ''}>
              <option value="">All</option>
              {STEP_ORDER.map((t) => (
                <option key={t} value={t}>
                  {STEP_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-primary btn-sm">
            Filter
          </button>
        </form>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {props.entries.length === 0 ? <p data-state="empty">No actions yet.</p> : null}
      {props.entries.length > 0 ? (
        <TableScroll>
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
                    <td>{e.ruleName ?? 'Approved suggestion'}</td>
                    <td>{STEP_LABEL[e.type]}</td>
                    <td>
                      {outcomeText(e.status, e.reasonCode)}
                      {undone ? <small>{` (${undone})`}</small> : null}
                    </td>
                    <td>
                      {e.undoable ? (
                        <button
                          type="button"
                          className="btn-sm"
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
        </TableScroll>
      ) : null}
      {props.next ? (
        <Link href={`${page}?${more.toString()}`} className="self-start text-small font-medium">
          Load more
        </Link>
      ) : null}
    </div>
  );
}
