'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import type { CommentPermissions, TagDto, TagOption } from '../../lib/org-comments';
import {
  rowResultText,
  tagErrorText,
  triageRequest,
  type TriageOp,
  type TriageResult,
} from '../../lib/triage';
import { TagPicker } from './tag-picker';

/** Mark done or reopen one comment, and change its tags. Done and tags never reach a platform. */
export function RowTriage({
  orgId,
  comment,
  tags,
  permissions,
}: {
  orgId: string;
  comment: { id: string; done: { at: string } | null; tags: TagOption[] };
  tags: TagOption[];
  permissions: CommentPermissions;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!permissions.triage) return null;

  async function triage(op: TriageOp): Promise<void> {
    const res = await apiFetch<{ results: TriageResult[] }>(
      `/api/v1/orgs/${orgId}/comments/triage`,
      { method: 'POST', body: triageRequest([comment.id], op) },
    );
    const failed = rowResultText(res.results[0]?.status ?? 'not_found');
    if (failed) throw new RowError(failed);
  }

  /** Runs one change, then reloads the list; failures stay on the row. */
  async function run(change: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await change();
      router.refresh();
    } catch (err) {
      setError(err instanceof RowError ? err.message : tagErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  // A name that is already taken applies the existing tag.
  async function createAndApply(name: string) {
    let tag: TagOption;
    try {
      tag = (
        await apiFetch<{ tag: TagDto }>(`/api/v1/orgs/${orgId}/tags`, {
          method: 'POST',
          body: { name },
        })
      ).tag;
    } catch (err) {
      if (!(err instanceof ApiRequestError && err.code === 'tag_name_taken' && err.tag)) throw err;
      tag = err.tag;
    }
    if (!comment.tags.some((t) => t.id === tag.id))
      await triage({ type: 'add_tags', tagIds: [tag.id] });
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(() => triage({ type: comment.done ? 'reopen' : 'done' }))}
      >
        {comment.done ? 'Reopen' : 'Mark done'}
      </button>
      <TagPicker
        tags={tags}
        applied={comment.tags}
        busy={busy}
        onAdd={(id) => void run(() => triage({ type: 'add_tags', tagIds: [id] }))}
        onRemove={(id) => void run(() => triage({ type: 'remove_tags', tagIds: [id] }))}
        onCreate={(name) => void run(() => createAndApply(name))}
      />
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

/** A per-comment refusal from the triage route, already worded for the row. */
class RowError extends Error {}
