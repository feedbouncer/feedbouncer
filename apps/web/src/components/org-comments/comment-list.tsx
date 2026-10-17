'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '../../lib/api-client';
import type { CommentPermissions, TagOption, VisibleCommentDto } from '../../lib/org-comments';
import {
  bulkSummary,
  tagErrorText,
  triageRequest,
  type TriageOp,
  type TriageResult,
} from '../../lib/triage';
import { BulkBar } from './bulk-bar';
import { CommentRow } from './comment-row';
import { ReplyComposer } from './reply-composer';
import { RowTriage } from './row-triage';

type Summary = { headline: string; failures: string[] } | { error: string };

/** The page of comments, with selection and bulk triage, and per-row triage and replies. */
export function CommentList({
  orgId,
  items,
  tags,
  permissions,
  canManageConnections,
}: {
  orgId: string;
  items: VisibleCommentDto[];
  tags: TagOption[];
  permissions: CommentPermissions;
  canManageConnections: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Stays until the next selection or bulk run.
  const [summary, setSummary] = useState<Summary | null>(null);
  // Rows that left the page (e.g. marked done in the open queue) drop out of the selection.
  const chosen = items.filter((c) => selected.has(c.id));
  const allChosen = items.length > 0 && chosen.length === items.length;

  function select(next: ReadonlySet<string>) {
    setSelected(next);
    setSummary(null);
  }

  function toggle(id: string, on: boolean) {
    const next = new Set(chosen.map((c) => c.id));
    if (on) next.add(id);
    else next.delete(id);
    select(next);
  }

  async function runBulk(op: TriageOp) {
    const ids = chosen.map((c) => c.id);
    const bodies = new Map(chosen.map((c) => [c.id, c.body]));
    setBusy(true);
    setSummary(null);
    try {
      const res = await apiFetch<{ results: TriageResult[] }>(
        `/api/v1/orgs/${orgId}/comments/triage`,
        { method: 'POST', body: triageRequest(ids, op) },
      );
      setSummary(bulkSummary(res.results, bodies));
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setSummary({ error: tagErrorText(err) });
    } finally {
      setBusy(false);
    }
  }

  const triage = permissions.triage;
  return (
    <>
      {triage ? (
        <>
          <BulkBar count={chosen.length} tags={tags} busy={busy} onRun={(op) => void runBulk(op)} />
          {summary ? (
            'error' in summary ? (
              <p role="alert">{summary.error}</p>
            ) : (
              <div role="status">
                <p>{summary.headline}</p>
                {summary.failures.length > 0 ? (
                  <ul>
                    {summary.failures.map((f, i) => (
                      <li key={i} dir="auto">
                        {f}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={allChosen}
              disabled={busy || items.length === 0}
              onChange={(e) => select(new Set(e.target.checked ? items.map((c) => c.id) : []))}
            />{' '}
            Select all on this page
          </label>
        </>
      ) : null}
      <ul>
        {items.map((c) => (
          <CommentRow
            key={c.id}
            item={c}
            select={
              triage ? (
                <input
                  type="checkbox"
                  aria-label={`Select comment by ${c.authorName ?? 'Unknown author'}`}
                  checked={selected.has(c.id)}
                  disabled={busy}
                  onChange={(e) => toggle(c.id, e.target.checked)}
                />
              ) : null
            }
            triage={
              triage ? (
                <RowTriage orgId={orgId} comment={c} tags={tags} permissions={permissions} />
              ) : null
            }
          >
            <ReplyComposer
              orgId={orgId}
              comment={c}
              reply={c.reply}
              canManageConnections={canManageConnections}
            />
          </CommentRow>
        ))}
      </ul>
    </>
  );
}
