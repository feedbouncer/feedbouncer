'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import {
  REVERSIBILITY_LABEL,
  STEP_LABEL,
  needsConfirm,
  openConfirm,
  resolveReviewItem,
  sourceText,
  type BrandApiBase,
  type ConfirmDialog,
  type Resolution,
  type ReviewItemView,
} from '../../lib/actions';
import { ApiRequestError } from '../../lib/api-client';
import { messageFor } from '../../lib/messages';

const BUTTONS: { resolution: Resolution; label: string }[] = [
  { resolution: 'approve', label: 'Approve' },
  { resolution: 'hide', label: STEP_LABEL.hide },
  { resolution: 'delete', label: STEP_LABEL.delete },
  { resolution: 'ban', label: STEP_LABEL.ban },
];

const CONFIRM_COPY = {
  delete: { title: 'Delete this comment?', button: 'Delete comment', label: 'delete' },
  ban: { title: 'Ban this author?', button: 'Ban author', label: 'ban' },
} as const;

export function ConfirmResolve(props: {
  dialog: ConfirmDialog;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const copy = CONFIRM_COPY[props.dialog.resolution];
  return (
    <div role="dialog" aria-modal="true" aria-label={copy.title}>
      <p>{copy.title}</p>
      <p role="note">{REVERSIBILITY_LABEL[props.dialog.resolution]}</p>
      <button type="button" disabled={props.busy} onClick={props.onConfirm}>
        {copy.button}
      </button>{' '}
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  );
}

export function ReviewQueue(props: {
  orgId: string;
  brandId: string;
  items: ReviewItemView[];
  next: string | null;
  /** False when no connected account can ban authors. */
  canBan?: boolean;
}) {
  const router = useRouter();
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<ConfirmDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const base =
    `/api/v1/orgs/${props.orgId}/brands/${props.brandId}` as const satisfies BrandApiBase;

  async function resolve(itemId: string, resolution: Resolution, requestKey: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await resolveReviewItem(base, itemId, resolution, requestKey);
      setResolved((s) => new Set(s).add(itemId));
      setDialog(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? messageFor(err.code) : 'Something went wrong.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function choose(itemId: string, resolution: Resolution) {
    if (needsConfirm(resolution)) setDialog(openConfirm(itemId, resolution));
    else void resolve(itemId, resolution, crypto.randomUUID());
  }

  const items = props.items.filter((i) => !resolved.has(i.id));
  if (items.length === 0 && !props.next) return <p>Nothing to review.</p>;
  return (
    <div>
      {error ? <p role="alert">{error}</p> : null}
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <p dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {i.commentBody || '(no text: sticker or attachment)'}
            </p>
            <small>
              {i.authorName ? `${i.authorName} · ` : ''}
              {sourceText(i.source, i.ruleName)}
            </small>
            <div>
              {BUTTONS.filter((b) => b.resolution !== 'ban' || props.canBan !== false).map((b) => (
                <button
                  key={b.resolution}
                  type="button"
                  disabled={busy}
                  onClick={() => choose(i.id, b.resolution)}
                >
                  {b.label}
                </button>
              ))}
            </div>
            {dialog?.itemId === i.id ? (
              <ConfirmResolve
                dialog={dialog}
                busy={busy}
                onConfirm={() => void resolve(dialog.itemId, dialog.resolution, dialog.requestKey)}
                onCancel={() => setDialog(null)}
              />
            ) : null}
          </li>
        ))}
      </ul>
      {props.next ? (
        <p>
          <Link
            href={`/orgs/${props.orgId}/brands/${props.brandId}/review?before=${encodeURIComponent(props.next)}`}
          >
            Load more
          </Link>
        </p>
      ) : null}
    </div>
  );
}
