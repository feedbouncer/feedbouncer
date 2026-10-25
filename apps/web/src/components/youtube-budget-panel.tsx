'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '../lib/api-client';
import { messageFor } from '../lib/messages';
import { YOUTUBE_ACTION_LABEL, linesToList, listToLines } from '../lib/rules';
import {
  DRY_RUN_BADGE,
  PROTECTED_HELP,
  bannerText,
  type YouTubeBudgetStatus,
} from '../lib/youtube-budget';
import { LocalTime, TextWithTimes } from './local-time';

type Props = { orgId: string; brandId: string; connectionId: string; canManage: boolean };

const url = (p: Pick<Props, 'orgId' | 'brandId' | 'connectionId'>) =>
  `/api/v1/orgs/${p.orgId}/brands/${p.brandId}/connections/${p.connectionId}/youtube` as const;

export function YouTubeBudgetPanel(props: Props) {
  const [status, setStatus] = useState<YouTubeBudgetStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const { orgId, brandId, connectionId } = props;
  useEffect(() => {
    let live = true;
    apiFetch<YouTubeBudgetStatus>(url({ orgId, brandId, connectionId }))
      .then((s) => live && setStatus(s))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [orgId, brandId, connectionId]);
  if (failed) return <p role="alert">Could not load the YouTube budget.</p>;
  if (!status) return <p>Loading YouTube budget…</p>;
  return <YouTubeBudgetView {...props} initial={status} />;
}

export function YouTubeBudgetView(props: Props & { initial: YouTubeBudgetStatus }) {
  const id = useId();
  const [status, setStatus] = useState(props.initial);
  const [budget, setBudget] = useState(String(props.initial.settings.dailyBudgetUnits));
  const [dryRun, setDryRun] = useState(props.initial.settings.dryRun);
  const [protectedIds, setProtectedIds] = useState(
    listToLines(props.initial.settings.protectedAuthorIds),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { today, backlog, limits, settings } = status;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const units = Number(budget);
    if (!/^\d+$/.test(budget) || units > limits.maxBudgetUnits) {
      setError(`Enter a whole number from 0 to ${limits.maxBudgetUnits}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await apiFetch<YouTubeBudgetStatus>(url(props), {
        method: 'PATCH',
        body: {
          dailyBudgetUnits: units,
          dryRun,
          protectedAuthorIds: linesToList(protectedIds),
        },
      });
      setStatus(next);
    } catch (err) {
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const tiers: [string, number][] = [
    [YOUTUBE_ACTION_LABEL.ban_author, backlog.ban],
    [YOUTUBE_ACTION_LABEL.delete, backlog.reject],
    [YOUTUBE_ACTION_LABEL.hide, backlog.hold],
    ['Publish', backlog.publish],
  ];
  return (
    <section aria-label="YouTube quota budget">
      <h3>YouTube quota budget</h3>
      {today.mode !== 'active' ? (
        <p role="status">
          <TextWithTimes build={(fmt) => bannerText(status, fmt) ?? ''} />
        </p>
      ) : null}
      {settings.dryRun ? <p role="status">{DRY_RUN_BADGE}</p> : null}
      <p>
        {today.spentUnits} / {today.budgetUnits} units used
      </p>
      <ul>
        <li>Reads: {today.readsSpentUnits}</li>
        <li>Writes: {today.writesSpentUnits}</li>
        <li>Read reserve: {today.readReserveUnits}</li>
        <li>Remaining: {today.remainingUnits}</li>
      </ul>
      <p>
        Resets at <LocalTime iso={today.resetAt} /> (midnight Pacific)
      </p>
      <p>Actions waiting:</p>
      <ul>
        {tiers.map(([label, n]) => (
          <li key={label}>
            {label}: {n}
          </li>
        ))}
      </ul>
      {backlog.skippedOverflowToday > 0 ? (
        <p>
          {backlog.skippedOverflowToday} actions were skipped today because the backlog is full.
        </p>
      ) : null}
      <p id={`${id}-help`}>{PROTECTED_HELP}</p>
      {props.canManage ? (
        <form onSubmit={(e) => void onSubmit(e)}>
          <p>
            <label>
              Daily budget (units, up to {limits.maxBudgetUnits}){' '}
              <input
                type="number"
                min={0}
                max={limits.maxBudgetUnits}
                step={1}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </label>
          </p>
          <p>
            <label>
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />{' '}
              Dry run
            </label>
          </p>
          <p>
            <label>
              Protected channel ids (one per line){' '}
              <textarea
                rows={4}
                value={protectedIds}
                aria-describedby={`${id}-help`}
                onChange={(e) => setProtectedIds(e.target.value)}
              />
            </label>
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" disabled={busy}>
            Save
          </button>
        </form>
      ) : settings.protectedAuthorIds.length > 0 ? (
        <ul aria-label="Protected channels">
          {settings.protectedAuthorIds.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
