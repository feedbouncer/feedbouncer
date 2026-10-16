'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { platformLabel } from '../../lib/actions';
import {
  pollItem,
  reasonLines,
  sourceText,
  stateText,
  unhide,
  unhideErrorText,
  type HiddenItemDto,
} from '../../lib/hidden-today';
import { singleFlight } from '../../lib/review-mode';
import { CommentBody } from '../comment-body';
import { LocalTime } from '../local-time';

// How often, and how long, to ask whether a queued unhide finished.
const POLL_MS = 2000;
const POLL_LIMIT = 30;

export function HiddenRow({
  item,
  onChange,
}: {
  item: HiddenItemDto;
  onChange: (item: HiddenItemDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; reconnect: boolean } | null>(null);
  const orgId = item.organizationId;
  const brandId = item.brandId;
  const hideActionId = item.hideActionId;

  // Memoised so singleFlight keeps its in-flight state across renders.
  const onClick = useMemo(
    () =>
      singleFlight(async () => {
        setBusy(true);
        setError(null);
        try {
          onChange(await unhide(orgId, brandId, hideActionId));
        } catch (err) {
          setError(unhideErrorText(err));
        } finally {
          setBusy(false);
        }
      }),
    [orgId, brandId, hideActionId, onChange],
  );

  const pending = item.state === 'pending';
  useEffect(() => {
    if (!pending) return;
    let tries = 0;
    let stopped = false;
    const timer = setInterval(() => {
      tries += 1;
      if (tries > POLL_LIMIT) return clearInterval(timer);
      pollItem(orgId, brandId, hideActionId).then(
        (next) => {
          if (!stopped && next.state !== 'pending') onChange(next);
        },
        () => undefined, // the next poll tries again
      );
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pending, orgId, brandId, hideActionId, onChange]);

  const state = stateText(item);
  return (
    <li>
      <p>
        <strong>{item.authorName ?? 'Unknown author'}</strong> · {platformLabel(item.platform)}{' '}
        {item.connectionName} · {item.brandName} · <LocalTime iso={item.hiddenAt} />
      </p>
      <CommentBody body={item.commentBody} />
      <p>{sourceText(item.source)}</p>
      {reasonLines(item).map((line, i) => (
        <p key={i}>{line}</p>
      ))}
      {state ? (
        <p role="status">
          <strong>{state.label}</strong>
          {state.detail ? ` ${state.detail}` : ''}
        </p>
      ) : null}
      {item.canUnhide ? (
        <button type="button" disabled={busy} onClick={() => void onClick()}>
          {busy ? 'Unhiding…' : 'Unhide'}
        </button>
      ) : null}
      {error ? (
        <p role="alert">
          {error.text}
          {error.reconnect ? (
            <>
              {' '}
              <Link href={`/orgs/${orgId}/brands/${brandId}/connections`}>Reconnect</Link>
            </>
          ) : null}
        </p>
      ) : null}
      <details>
        <summary>History</summary>
        <ul>
          {item.history.map((h, i) => (
            <li key={i}>
              <LocalTime iso={h.at} /> {h.kind === 'hide' ? 'Hidden' : 'Unhidden'}
              {h.actorName ? ` by ${h.actorName}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}
