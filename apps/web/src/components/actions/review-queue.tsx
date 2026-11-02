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
  delete: { title: 'Delete this comment?', button: 'Delete comment' },
  ban: { title: 'Ban this author?', button: 'Ban author' },
} as const;

export function ConfirmResolve(props: {
  dialog: ConfirmDialog;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const copy = CONFIRM_COPY[props.dialog.resolution];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <p className="font-semibold text-foreground">{copy.title}</p>
      <p role="note" className="text-small text-dim">
        {REVERSIBILITY_LABEL[props.dialog.resolution]}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-destructive btn-sm"
          disabled={props.busy}
          onClick={props.onConfirm}
        >
          {copy.button}
        </button>
        <button type="button" className="btn-sm" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
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
  if (items.length === 0 && !props.next) return <p data-state="empty">Nothing to review.</p>;
  const buttonStyle: Record<Resolution, string> = {
    approve: 'btn-sm',
    hide: 'btn-sm',
    delete: 'btn-destructive btn-sm',
    ban: 'btn-destructive btn-sm',
  };
  return (
    <div className="flex flex-col gap-4">
      {error ? <p role="alert">{error}</p> : null}
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
        {items.map((i) => (
          <li key={i.id} className="flex flex-col gap-3 p-(--fb-card-pad)">
            <p dir="auto" className="whitespace-pre-wrap">
              {i.commentBody || '(no text: sticker or attachment)'}
            </p>
            <small className="text-dim">
              {i.authorName ? `${i.authorName} · ` : ''}
              {sourceText(i.source, i.ruleName)}
            </small>
            <div className="flex flex-wrap gap-2">
              {BUTTONS.filter((b) => b.resolution !== 'ban' || props.canBan !== false).map((b) => (
                <button
                  key={b.resolution}
                  type="button"
                  className={buttonStyle[b.resolution]}
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
        <Link
          href={`/orgs/${props.orgId}/brands/${props.brandId}/review?before=${encodeURIComponent(props.next)}`}
          className="self-start text-small font-medium"
        >
          Load more
        </Link>
      ) : null}
    </div>
  );
}
