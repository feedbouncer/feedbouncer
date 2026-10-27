'use client';
import { useState } from 'react';
import {
  STATUS_LABEL,
  STEP_LABEL,
  commentLog,
  undoLogStep,
  undoText,
  type BrandApiBase,
  type LogEntryView,
} from '../lib/actions';
import { ApiRequestError } from '../lib/api-client';
import { formatUtc } from '../lib/format';
import { messageFor, outcomeText } from '../lib/messages';

/** Only a hide that went through can be taken back from here. */
const canUndo = (e: LogEntryView): boolean =>
  e.undoable && e.status === 'succeeded' && e.type === 'hide';

// The steps taken on one comment. Every server string is a text node.
export function HistoryRows(props: {
  entries: LogEntryView[];
  platform: string;
  busy: boolean;
  onUndo: (stepId: string) => void;
}) {
  if (props.entries.length === 0) return <p>No actions yet.</p>;
  return (
    <ul>
      {props.entries.map((e) => {
        const undone = undoText(e);
        return (
          <li key={e.id}>
            <strong>{e.ruleName ?? 'Manual'}</strong> · {STEP_LABEL[e.type]} ·{' '}
            {STATUS_LABEL[e.status]}
            {e.reasonCode ? `: ${outcomeText(e.reasonCode, props.platform)}` : null} ·{' '}
            {formatUtc(e.createdAt)}
            {e.previewText ? <blockquote>{e.previewText}</blockquote> : null}
            {e.deferredUntil ? (
              <p>
                {`Delayed until ${formatUtc(e.deferredUntil)}`}
                {e.deferredCode ? `: ${outcomeText(e.deferredCode, props.platform)}` : null}
              </p>
            ) : null}
            {undone ? <small>{` (${undone})`}</small> : null}
            {canUndo(e) ? (
              <button
                type="button"
                disabled={props.busy}
                aria-label={`Undo ${STEP_LABEL[e.type]}`}
                onClick={() => props.onUndo(e.id)}
              >
                {undone ? 'Retry undo' : 'Undo'}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function CommentHistory(props: {
  orgId: string;
  brandId: string;
  commentId: string;
  platform: string;
}) {
  const [entries, setEntries] = useState<LogEntryView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base =
    `/api/v1/orgs/${props.orgId}/brands/${props.brandId}` as const satisfies BrandApiBase;

  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');

  async function load() {
    setError(null);
    try {
      setEntries((await commentLog(base, props.commentId)).items);
    } catch (err) {
      fail(err);
    }
  }

  async function undo(stepId: string) {
    setBusy(true);
    setError(null);
    try {
      await undoLogStep(base, stepId);
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={() => (entries ? setEntries(null) : void load())}>
        {entries ? 'Hide history' : 'History'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {entries ? (
        <HistoryRows
          entries={entries}
          platform={props.platform}
          busy={busy}
          onUndo={(id) => void undo(id)}
        />
      ) : null}
    </div>
  );
}
