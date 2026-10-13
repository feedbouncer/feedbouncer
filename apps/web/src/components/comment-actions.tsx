'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiRequestError, apiFetch } from '../lib/api-client';
import { formatUtc } from '../lib/format';
import { messageFor, outcomeText } from '../lib/messages';

interface ActionView {
  id: string;
  kind: string;
  actorType: string;
  status: string;
  outcomeCode: string | null;
  createdAt: string;
}

type Kind =
  | 'hide'
  | 'unhide'
  | 'delete'
  | 'ban_author'
  | 'unban_author'
  | 'public_reply'
  | 'private_reply';

function resultText(a: { status: string; outcomeCode: string | null }): string {
  const why = a.outcomeCode ? outcomeText(a.outcomeCode) : '';
  switch (a.status) {
    case 'applied':
      return 'Done';
    case 'pending':
      return 'Queued';
    case 'noop':
      return `No change needed: ${why}`;
    case 'not_eligible':
      return `Not eligible: ${why}`;
    default:
      return `Failed: ${why || outcomeText('')}`;
  }
}

export function CommentActions(props: {
  orgId: string;
  brandId: string;
  commentId: string;
  state: 'visible' | 'hidden' | 'deleted';
  canBan: boolean;
  privateReplyOpen: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const [history, setHistory] = useState<ActionView[] | null>(null);
  const base = `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/comments/${props.commentId}/actions`;

  async function run(kind: Kind, text?: string): Promise<boolean> {
    // One key per click; the API treats a repeat of it as the same request.
    const requestKey = crypto.randomUUID();
    setBusy(true);
    setStatus(null);
    try {
      const res = await apiFetch<{ action: ActionView }>(base as `/api/${string}`, {
        method: 'POST',
        body: { kind, requestKey, ...(text === undefined ? {} : { text }) },
      });
      setStatus({ error: false, text: resultText(res.action) });
      setHistory(null);
      router.refresh();
      return true;
    } catch (err) {
      const text = err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.';
      setStatus({ error: true, text });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onReply(e: FormEvent<HTMLFormElement>, kind: Kind) {
    e.preventDefault();
    const form = e.currentTarget;
    const text = String(new FormData(form).get('text') ?? '').trim();
    if (text && (await run(kind, text))) form.reset();
  }

  async function toggleHistory() {
    if (history) return setHistory(null);
    try {
      const res = await apiFetch<{ actions: ActionView[] }>(base as `/api/${string}`);
      setHistory(res.actions);
    } catch (err) {
      setStatus({
        error: true,
        text: err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.',
      });
    }
  }

  const gone = props.state === 'deleted';
  return (
    <div>
      {gone ? null : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(props.state === 'hidden' ? 'unhide' : 'hide')}
          >
            {props.state === 'hidden' ? 'Unhide' : 'Hide'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (confirm('Delete this comment on Facebook? This cannot be undone.'))
                void run('delete');
            }}
          >
            Delete
          </button>
        </>
      )}
      {props.canBan ? (
        <>
          <button type="button" disabled={busy} onClick={() => run('ban_author')}>
            Ban author
          </button>
          <button type="button" disabled={busy} onClick={() => run('unban_author')}>
            Unban author
          </button>
        </>
      ) : null}
      {gone ? null : (
        <>
          <form onSubmit={(e) => onReply(e, 'public_reply')}>
            <textarea name="text" aria-label="Public reply" maxLength={8000} required />
            <button type="submit" disabled={busy}>
              Reply publicly
            </button>
          </form>
          <form onSubmit={(e) => onReply(e, 'private_reply')}>
            <textarea
              name="text"
              aria-label="Private reply"
              maxLength={8000}
              required
              disabled={!props.privateReplyOpen}
            />
            <button type="submit" disabled={busy || !props.privateReplyOpen}>
              Reply privately
            </button>
            {props.privateReplyOpen ? null : <small> Private reply window closed</small>}
          </form>
        </>
      )}
      {status ? <p role={status.error ? 'alert' : 'status'}>{status.text}</p> : null}
      <button type="button" onClick={toggleHistory}>
        {history ? 'Hide history' : 'History'}
      </button>
      {history ? (
        history.length === 0 ? (
          <p>No actions yet.</p>
        ) : (
          <ul>
            {history.map((a) => (
              <li key={a.id}>
                {a.kind} by {a.actorType}: {resultText(a)} ({formatUtc(a.createdAt)})
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
