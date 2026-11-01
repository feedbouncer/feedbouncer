'use client';
import { useState } from 'react';
import type { TagOption } from '../../lib/org-comments';
import type { TriageOp } from '../../lib/triage';

/** Done, reopen and tag changes for the selected comments; hidden while nothing is selected. */
export function BulkBar({
  count,
  tags,
  busy,
  onRun,
}: {
  count: number;
  tags: TagOption[];
  busy: boolean;
  onRun: (op: TriageOp) => void;
}) {
  const [pick, setPick] = useState('');
  if (count === 0) return null;
  const tagId = tags.some((t) => t.id === pick) ? pick : (tags[0]?.id ?? '');
  const noTag = busy || tagId === '';
  return (
    <div
      role="group"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-4"
    >
      <span className="font-semibold text-foreground">{`${count} selected`}</span>
      <button type="button" className="btn-sm" disabled={busy} onClick={() => onRun({ type: 'done' })}>
        Mark done
      </button>
      <button type="button" className="btn-sm" disabled={busy} onClick={() => onRun({ type: 'reopen' })}>
        Reopen
      </button>
      {tags.length > 0 ? (
        <select
          aria-label="Tag"
          value={tagId}
          disabled={busy}
          onChange={(e) => setPick(e.target.value)}
        >
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        className="btn-sm"
        disabled={noTag}
        onClick={() => onRun({ type: 'add_tags', tagIds: [tagId] })}
      >
        Add tag
      </button>
      <button
        type="button"
        className="btn-sm"
        disabled={noTag}
        onClick={() => onRun({ type: 'remove_tags', tagIds: [tagId] })}
      >
        Remove tag
      </button>
    </div>
  );
}
