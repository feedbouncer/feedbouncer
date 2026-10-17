'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '../../lib/api-client';
import type { TagDto } from '../../lib/org-comments';
import { confirmAndDeleteTag, tagErrorText } from '../../lib/triage';

/** Deletes a tag from the workspace after the viewer confirms how many comments lose it. */
export function DeleteTagButton({ orgId, tag }: { orgId: string; tag: TagDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const r = await confirmAndDeleteTag(
        tag.name,
        tag.commentCount,
        (m) => window.confirm(m),
        async (confirmCount) => {
          await apiFetch(`/api/v1/orgs/${orgId}/tags/${tag.id}`, {
            method: 'DELETE',
            body: { confirmCount },
          });
        },
      );
      if (r === 'deleted') router.refresh();
    } catch (err) {
      setError(tagErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={`Delete tag ${tag.name}`}
        disabled={busy}
        onClick={() => void onClick()}
      >
        Delete
      </button>
      {error ? <span role="alert"> {error}</span> : null}
    </>
  );
}
