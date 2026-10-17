'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useReducer, type FormEvent } from 'react';
import { platformLabel } from '../../lib/actions';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import { POLL_LIMIT, POLL_MS, reasonText, replyCheck } from '../../lib/moderation';
import type { ReplyAvailability, ReplyDto } from '../../lib/org-comments';
import {
  draftStatus,
  isInFlight,
  newDraft,
  replyDraft,
  type Draft,
  type DraftEvent,
} from '../../lib/reply-draft';

const newKey = () => crypto.randomUUID();
const reduce = (d: Draft, e: DraftEvent) => replyDraft(d, e, newKey);

/** Why the viewer can't reply to this comment now. */
export function unavailableText(reason: string, platform: string): string {
  const p = platformLabel(platform);
  switch (reason) {
    case 'unsupported':
      return `Replying isn't available for ${p} comments.`;
    case 'connection_needs_reconnect':
      return `Reconnect this ${p} account to reply.`;
    case 'connection_inactive':
      return `This ${p} account is paused, so replies can't be sent.`;
    default:
      return reasonText(reason, platform);
  }
}

/** A public reply to one comment of the list. The text renders only as the textarea's value. */
export function ReplyComposer({
  orgId,
  comment,
  reply,
  canManageConnections,
}: {
  orgId: string;
  comment: { id: string; platform: string; brandId: string };
  reply: ReplyAvailability;
  canManageConnections: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [d, dispatch] = useReducer(reduce, newKey, newDraft);
  const base = `/api/v1/orgs/${orgId}/comments/${comment.id}/replies` as const;
  const pendingId = d.phase === 'pending' ? d.actionId : null;
  const settled = d.phase === 'sent' || d.phase === 'gone';

  // A queued reply is posted by a worker; ask until the API reports its result.
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
      apiFetch<{ replies: ReplyDto[] }>(base).then(
        (res) => {
          const r = res.replies.find((x) => x.id === pendingId);
          if (!stopped && r)
            dispatch({ type: 'polled', status: r.status, outcomeCode: r.outcomeCode });
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
    if (settled) router.refresh();
  }, [settled, router]);

  // Sends this render's draft: its key and text go together, so a retry replays the same request.
  async function send() {
    const { requestKey, text } = d;
    dispatch({ type: 'send' });
    try {
      const res = await apiFetch<{ reply: ReplyDto }>(base, {
        method: 'POST',
        body: { requestKey, text: text.trim() },
      });
      dispatch({
        type: 'accepted',
        actionId: res.reply.id,
        status: res.reply.status,
        outcomeCode: res.reply.outcomeCode,
      });
    } catch (err) {
      // A 4xx is a refusal of this request; anything else may have reached the server.
      if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500)
        dispatch({
          type: 'refused',
          code: err.code,
          ...(err.max === undefined ? {} : { max: err.max }),
        });
      else dispatch({ type: 'network_error' });
    }
  }

  const available = reply.available && d.phase !== 'not_permitted';
  const max = reply.available ? reply.maxChars : 0;
  const check = replyCheck(d.text, max);
  const inFlight = isInFlight(d);
  const canSend = available && !inFlight && d.phase !== 'gone' && check.canSubmit;
  const status = draftStatus(d, comment.platform);
  const textId = `${id}-text`;
  const describedBy = `${id}-describe`;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (canSend) void send();
  }

  return (
    <form onSubmit={onSubmit}>
      <label htmlFor={textId}>Reply</label>{' '}
      <textarea
        id={textId}
        name="text"
        dir="auto"
        aria-describedby={describedBy}
        aria-invalid={check.over || undefined}
        disabled={!available}
        readOnly={inFlight}
        value={d.text}
        onChange={(e) => dispatch({ type: 'edit', text: e.target.value })}
      />
      <button type="submit" disabled={!canSend}>
        Send reply
      </button>{' '}
      {reply.available ? (
        <small id={describedBy}>
          {`${check.count} / ${check.max}`}
          {check.over ? ` Too long for ${platformLabel(comment.platform)}.` : ''}
        </small>
      ) : (
        <small id={describedBy}>
          {unavailableText(reply.reason, comment.platform)}
          {reply.reason === 'connection_needs_reconnect' && canManageConnections ? (
            <>
              {' '}
              <Link href={`/orgs/${orgId}/brands/${comment.brandId}/connections`}>Reconnect</Link>
            </>
          ) : null}
        </small>
      )}
      {status ? (
        <p role={status.alert ? 'alert' : 'status'}>
          {status.text}
          {status.retry && canSend ? (
            <>
              {' '}
              <button type="button" onClick={() => void send()}>
                Try again
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
