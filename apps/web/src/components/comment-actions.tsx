'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useReducer, useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '../lib/api-client';
import { formatUtc } from '../lib/format';
import { actionKindText, actorTypeText, messageFor } from '../lib/messages';
import {
  confirmDelete,
  historyText,
  isBusy,
  progress,
  progressText,
  reasonText,
  rejectionText,
  replyCheck,
  shownActions,
  type ActionKind,
  type ActionStatus,
  type Availability,
  type CommentState,
  type ReplyKind,
  type ReplyLimits,
  type ShownAction,
} from '../lib/moderation';

interface ActionView {
  id: string;
  kind: string;
  actorType: string;
  status: ActionStatus;
  outcomeCode: string | null;
  createdAt: string;
}

// How often, and how long, to ask the API whether a queued action finished.
const POLL_MS = 2000;
const POLL_LIMIT = 30;

const REPLY_COPY: Record<ReplyKind, { label: string; submit: string }> = {
  public_reply: { label: 'Public reply', submit: 'Reply publicly' },
  private_reply: { label: 'Private reply', submit: 'Reply privately' },
};

function ReplyForm(props: {
  action: ShownAction<ReplyKind>;
  platform: string;
  max: number;
  busy: boolean;
  onSend: (kind: ReplyKind, text: string) => Promise<boolean>;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const check = replyCheck(text, props.max);
  const { kind, available, reason } = props.action;
  const reasonId = `${id}-reason`;
  const counterId = `${id}-count`;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!available || !check.canSubmit) return;
    if (await props.onSend(kind, text.trim())) setText('');
  }

  return (
    <form onSubmit={onSubmit}>
      <textarea
        name="text"
        aria-label={REPLY_COPY[kind].label}
        aria-describedby={available ? counterId : reasonId}
        aria-invalid={check.over || undefined}
        required
        disabled={!available}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="submit"
        disabled={props.busy || !available || !check.canSubmit}
        aria-describedby={available ? counterId : reasonId}
      >
        {REPLY_COPY[kind].submit}
      </button>{' '}
      {available ? (
        <small id={counterId}>
          {`${check.count} / ${check.max}`}
          {check.over ? ' Too long for this platform.' : ''}
        </small>
      ) : (
        <small id={reasonId}>{reasonText(reason ?? '', props.platform)}</small>
      )}
    </form>
  );
}

export function CommentActions(props: {
  orgId: string;
  brandId: string;
  commentId: string;
  platform: string;
  state: CommentState;
  availability: Availability;
  replyLimits: ReplyLimits;
}) {
  const router = useRouter();
  const id = useId();
  const [p, dispatch] = useReducer(progress, { phase: 'idle' });
  const [history, setHistory] = useState<ActionView[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const base =
    `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/comments/${props.commentId}/actions` as const;
  const busy = isBusy(p);
  const pendingId = p.phase === 'pending' ? p.actionId : null;
  const done = p.phase === 'done';

  // A queued action is applied by a worker; ask until the API reports its result.
  useEffect(() => {
    if (pendingId === null) return;
    let tries = 0;
    let stopped = false;
    const timer = setInterval(() => {
      tries += 1;
      if (tries > POLL_LIMIT) {
        clearInterval(timer);
        dispatch({ type: 'gave_up' });
        return;
      }
      apiFetch<{ actions: ActionView[] }>(base).then(
        (res) => {
          if (!stopped) dispatch({ type: 'polled', actions: res.actions });
        },
        () => undefined, // the next poll tries again
      );
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingId, base]);

  useEffect(() => {
    if (!done) return;
    setHistory(null);
    router.refresh();
  }, [done, router]);

  async function run(kind: ActionKind, text?: string): Promise<boolean> {
    // One key per click; the API treats a repeat of it as the same request.
    const requestKey = crypto.randomUUID();
    dispatch({ type: 'submit' });
    try {
      const res = await apiFetch<{ action: ActionView }>(base, {
        method: 'POST',
        body: { kind, requestKey, ...(text === undefined ? {} : { text }) },
      });
      dispatch({ type: 'accepted', action: res.action });
      return true;
    } catch (err) {
      const message =
        err instanceof ApiRequestError ? rejectionText(err.code, err.max) : 'Something went wrong.';
      dispatch({ type: 'rejected', message });
      return false;
    }
  }

  function onClick(kind: ActionKind) {
    if (kind === 'delete' && !confirmDelete(props.platform, (m) => window.confirm(m))) return;
    void run(kind);
  }

  async function toggleHistory() {
    if (history) return setHistory(null);
    setHistoryError(null);
    try {
      const res = await apiFetch<{ actions: ActionView[] }>(base);
      setHistory(res.actions);
    } catch (err) {
      setHistoryError(
        err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.',
      );
    }
  }

  const { buttons, replies } = shownActions(props.state, props.availability);
  const status = progressText(p, props.platform);
  return (
    <div>
      {buttons.map((b) => {
        const reasonId = `${id}-${b.kind}-reason`;
        return (
          <span key={b.kind}>
            <button
              type="button"
              disabled={busy || !b.available}
              aria-describedby={b.available ? undefined : reasonId}
              onClick={() => onClick(b.kind)}
            >
              {actionKindText(b.kind)}
            </button>
            {b.available ? null : (
              <>
                {' '}
                <small id={reasonId}>{reasonText(b.reason ?? '', props.platform)}</small>
              </>
            )}{' '}
          </span>
        );
      })}
      {replies.map((r) => (
        <ReplyForm
          key={r.kind}
          action={r}
          platform={props.platform}
          max={props.replyLimits[r.kind]}
          busy={busy}
          onSend={run}
        />
      ))}
      {status ? <p role={status.alert ? 'alert' : 'status'}>{status.text}</p> : null}
      <button type="button" onClick={toggleHistory}>
        {history ? 'Hide history' : 'History'}
      </button>
      {historyError ? <p role="alert">{historyError}</p> : null}
      {history ? (
        history.length === 0 ? (
          <p>No actions yet.</p>
        ) : (
          <ul>
            {history.map((a) => (
              <li key={a.id}>
                {`${actionKindText(a.kind)} by ${actorTypeText(a.actorType)}: ${historyText(a, props.platform)} (${formatUtc(a.createdAt)})`}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
