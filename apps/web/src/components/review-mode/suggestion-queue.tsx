'use client';
import {
  GATED_STEP_TYPES,
  SUGGESTION_STATUSES,
  needsConfirmation,
} from '@feedbouncer/actions/shared';
import type { SuggestionStatus } from '@feedbouncer/actions/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { STEP_LABEL, conflictText, outcomeText, type BrandApiBase } from '../../lib/actions';
import {
  bulkByAuthor,
  bulkByIds,
  decide,
  decisionErrorText,
  formatLocal,
  openDecision,
  queueHref,
  singleFlight,
  suggestionStatusText,
  type Decision,
  type PendingAuthor,
  type PendingDecision,
  type QueueFilter,
  type SuggestionSourceView,
  type SuggestionView,
} from '../../lib/review-mode';
import { TextWithTimes } from '../local-time';

const EMPTY =
  'No suggestions waiting. During review mode, when a rule, the classifier or a policy matches a comment, the action it would take appears here for you to approve or dismiss.';

const STATUS_LABEL: Record<SuggestionStatus | 'all', string> = {
  pending: 'Waiting for review',
  approved: 'Approved',
  dismissed: 'Dismissed',
  expired: 'Expired',
  not_applicable: 'No longer applicable',
  withdrawn: 'Withdrawn',
  all: 'All',
};

function sourceLabel(s: SuggestionSourceView): string {
  if (s.type === 'classifier') return 'AI classifier';
  if (s.type === 'policy') return 'Custom policy';
  return `Rule: ${s.ruleName ?? 'deleted rule'}`;
}

/** An approval waiting for confirmation; its request key was made when it opened. */
type Dialog =
  | { kind: 'one'; decision: PendingDecision }
  | { kind: 'ids'; ids: string[]; requestKey: string }
  | { kind: 'author'; requestKey: string };

export function ConfirmApprove(props: {
  title: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="dialog" aria-modal="true" aria-label={props.title}>
      <p>{props.title}</p>
      <p role="note">This runs every suggested action, including deletes and bans.</p>
      <button type="button" disabled={props.busy} onClick={props.onConfirm}>
        Approve and run
      </button>{' '}
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  );
}

export function SuggestionQueue(props: {
  orgId: string;
  brandId: string;
  items: SuggestionView[];
  next: string | null;
  /** Authors with pending suggestions on the filtered connection. */
  authors: PendingAuthor[];
  filter: QueueFilter;
  connections: { id: string; name: string }[];
  rules: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [guard] = useState(() => singleFlight((task: () => Promise<void>) => task()));
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [handled, setHandled] = useState<
    ReadonlyMap<string, (fmt: (iso: string) => string) => string>
  >(new Map());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const base =
    `/api/v1/orgs/${props.orgId}/brands/${props.brandId}` as const satisfies BrandApiBase;
  const { filter } = props;
  const authorScope =
    filter.connectionId && filter.authorId
      ? { connectionId: filter.connectionId, authorId: filter.authorId }
      : null;

  const items = props.items.filter((i) => !done.has(i.id));
  const pendingIds = items.filter((i) => i.status === 'pending').map((i) => i.id);
  const allSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));

  const run = (task: () => Promise<void>) =>
    guard(async () => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await task();
        setDialog(null);
        router.refresh();
      } catch (err) {
        setError(decisionErrorText(err, formatLocal).text);
      } finally {
        setBusy(false);
      }
    });

  const decideOne = (d: PendingDecision) =>
    guard(async () => {
      setBusy(true);
      setError(null);
      try {
        await decide(base, d);
        setDone((s) => new Set(s).add(d.suggestionId));
        setDialog(null);
        router.refresh();
      } catch (err) {
        if (decisionErrorText(err, formatLocal).handled) {
          setHandled((m) =>
            new Map(m).set(d.suggestionId, (fmt) => decisionErrorText(err, fmt).text),
          );
          setDialog(null);
        } else setError(decisionErrorText(err, formatLocal).text);
      } finally {
        setBusy(false);
      }
    });

  function choose(s: SuggestionView, action: Decision) {
    const d = openDecision(s, action);
    if (d.confirm) setDialog({ kind: 'one', decision: d });
    else void decideOne(d);
  }

  const decideIds = (action: Decision, ids: string[], requestKey: string, confirm: boolean) =>
    run(async () => {
      const { results } = await bulkByIds(base, action, ids, requestKey, confirm);
      const ok = results.filter(
        (r) => r.result.status === 'approved' || r.result.status === 'dismissed',
      );
      setDone((s) => new Set([...s, ...ok.map((r) => r.id)]));
      setSelected(new Set());
      setNotice(
        `${ok.length} of ${results.length} suggestions ${action === 'approve' ? 'approved' : 'dismissed'}.`,
      );
    });

  function chooseSelected(action: Decision) {
    const picked = items.filter((i) => selected.has(i.id));
    if (picked.length === 0) return;
    const ids = picked.map((i) => i.id);
    if (action === 'approve' && picked.some((i) => needsConfirmation(i.plan.steps)))
      setDialog({ kind: 'ids', ids, requestKey: crypto.randomUUID() });
    else void decideIds(action, ids, crypto.randomUUID(), false);
  }

  const decideAuthor = (action: Decision, requestKey: string) =>
    run(async () => {
      if (!authorScope) return;
      const { matched } = await bulkByAuthor(
        base,
        action,
        authorScope.connectionId,
        authorScope.authorId,
        requestKey,
      );
      setNotice(
        `${matched} suggestions from this author will be ${action === 'approve' ? 'approved' : 'dismissed'} in the background.`,
      );
    });

  return (
    <div>
      <form method="get">
        <label>
          Account{' '}
          <select name="connectionId" defaultValue={filter.connectionId ?? ''}>
            <option value="">All</option>
            {props.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Rule{' '}
          <select name="ruleId" defaultValue={filter.ruleId ?? ''}>
            <option value="">All</option>
            {props.rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Proposed action{' '}
          <select name="stepType" defaultValue={filter.stepType ?? ''}>
            <option value="">All</option>
            {GATED_STEP_TYPES.map((t) => (
              <option key={t} value={t}>
                {STEP_LABEL[t]}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Status{' '}
          <select name="status" defaultValue={filter.status ?? 'pending'}>
            {[...SUGGESTION_STATUSES, 'all' as const].map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>{' '}
        {filter.connectionId ? (
          <>
            <label>
              Author{' '}
              <select name="authorId" defaultValue={filter.authorId ?? ''}>
                <option value="">All</option>
                {props.authors.map((a) => (
                  <option key={a.authorId} value={a.authorId}>
                    {`${a.authorName ?? 'Unknown author'} (${a.pendingCount})`}
                  </option>
                ))}
              </select>
            </label>{' '}
          </>
        ) : null}
        <button type="submit">Filter</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {authorScope ? (
        <p>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDialog({ kind: 'author', requestKey: crypto.randomUUID() })}
          >
            Approve all from this author
          </button>{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => void decideAuthor('dismiss', crypto.randomUUID())}
          >
            Dismiss all from this author
          </button>
        </p>
      ) : null}
      {dialog?.kind === 'author' ? (
        <ConfirmApprove
          title="Approve every waiting suggestion from this author?"
          busy={busy}
          onConfirm={() => void decideAuthor('approve', dialog.requestKey)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {items.length === 0 && !props.next ? (
        <p>{EMPTY}</p>
      ) : (
        <>
          {pendingIds.length > 0 ? (
            <p>
              <label>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) =>
                    setSelected(e.currentTarget.checked ? new Set(pendingIds) : new Set())
                  }
                />{' '}
                Select all on this page
              </label>{' '}
              <button
                type="button"
                disabled={busy || selected.size === 0}
                onClick={() => chooseSelected('approve')}
              >
                Approve selected
              </button>{' '}
              <button
                type="button"
                disabled={busy || selected.size === 0}
                onClick={() => chooseSelected('dismiss')}
              >
                Dismiss selected
              </button>
            </p>
          ) : null}
          {dialog?.kind === 'ids' ? (
            <ConfirmApprove
              title={`Approve ${dialog.ids.length} selected suggestions?`}
              busy={busy}
              onConfirm={() => void decideIds('approve', dialog.ids, dialog.requestKey, true)}
              onCancel={() => setDialog(null)}
            />
          ) : null}
          <ul>
            {items.map((s) => {
              const handledBy = handled.get(s.id);
              return (
                <li key={s.id}>
                  {s.status === 'pending' && !handledBy ? (
                    <input
                      type="checkbox"
                      aria-label="Select this suggestion"
                      checked={selected.has(s.id)}
                      onChange={(e) => {
                        const on = e.currentTarget.checked;
                        setSelected((cur) => {
                          const next = new Set(cur);
                          if (on) next.add(s.id);
                          else next.delete(s.id);
                          return next;
                        });
                      }}
                    />
                  ) : null}
                  <p dir="auto" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {s.commentBody || '(no text: sticker or attachment)'}
                  </p>
                  <small>
                    {s.authorName ?? 'Unknown author'}
                    {s.authorId && s.authorPendingCount >= 2 ? (
                      <>
                        {' · '}
                        <Link
                          href={queueHref(props.orgId, props.brandId, {
                            connectionId: s.connectionId,
                            authorId: s.authorId,
                          })}
                        >
                          {`${s.authorPendingCount} pending from this author`}
                        </Link>
                      </>
                    ) : null}
                  </small>
                  <ul>
                    {s.sources.map((src, i) => (
                      <li key={i}>
                        {sourceLabel(src)}
                        {src.reason ? ` · ${src.reason}` : ''}
                        {src.alsoMatched.length > 0
                          ? ` · Also matched: ${src.alsoMatched.map((m) => m.ruleName).join(', ')}`
                          : ''}
                      </li>
                    ))}
                  </ul>
                  <p>
                    {`Proposed: ${s.plan.steps.map((st) => STEP_LABEL[st.type]).join(', ') || 'nothing'}`}
                  </p>
                  {s.plan.dropped.length > 0 ? (
                    <ul>
                      {s.plan.dropped.map((d) => (
                        <li
                          key={d.type}
                        >{`${STEP_LABEL[d.type]} left out: ${conflictText(d.reason)}`}</li>
                      ))}
                    </ul>
                  ) : null}
                  {s.execution ? (
                    <ul>
                      {s.execution.steps.map((st) => (
                        <li key={st.type}>
                          {`${STEP_LABEL[st.type]}: ${outcomeText(st.status, st.reason)}`}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p role={handledBy ? 'status' : undefined}>
                    <TextWithTimes build={handledBy ?? ((fmt) => suggestionStatusText(s, fmt))} />
                  </p>
                  {s.status === 'pending' && !handledBy ? (
                    <div>
                      <button type="button" disabled={busy} onClick={() => choose(s, 'approve')}>
                        Approve
                      </button>{' '}
                      <button type="button" disabled={busy} onClick={() => choose(s, 'dismiss')}>
                        Dismiss
                      </button>
                    </div>
                  ) : null}
                  {dialog?.kind === 'one' && dialog.decision.suggestionId === s.id ? (
                    <ConfirmApprove
                      title="Approve this suggestion?"
                      busy={busy}
                      onConfirm={() => void decideOne(dialog.decision)}
                      onCancel={() => setDialog(null)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {props.next ? (
        <p>
          <Link href={queueHref(props.orgId, props.brandId, { ...filter, before: props.next })}>
            Load more
          </Link>
        </p>
      ) : null}
    </div>
  );
}
