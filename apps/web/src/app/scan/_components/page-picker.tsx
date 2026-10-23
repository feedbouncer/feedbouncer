'use client';
import type { ScanPageOption } from '@feedbouncer/scan/contract';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiRequestError, apiFetch } from '../../../lib/api-client';

export function PagePicker({ grantId, pages }: { grantId: string; pages: ScanPageOption[] }) {
  const router = useRouter();
  const [pageId, setPageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!pageId) return;
    setBusy(true);
    setError(null);
    try {
      const { scanId } = await apiFetch<{ scanId: string }>('/api/v1/scan/scans', {
        method: 'POST',
        body: { grantId, pageId },
      });
      router.push(`/scan/results/${scanId}`);
    } catch (err) {
      if (err instanceof ApiRequestError && err.scanId) {
        router.push(`/scan/results/${err.scanId}`);
        return;
      }
      setError(
        err instanceof ApiRequestError && err.status === 429
          ? 'Too many scans. Try again later.'
          : err instanceof ApiRequestError && err.code === 'scan_in_progress'
            ? 'This Page is already being scanned. Try again in a few minutes.'
            : err instanceof ApiRequestError && err.status === 404
              ? 'This connection expired. Connect again.'
              : 'Could not start the scan. Try again.',
      );
      setBusy(false);
    }
  }

  return (
    <>
      <fieldset>
        <legend>Pick a Page to scan</legend>
        {pages.map((p) => (
          <label key={p.pageId}>
            <input
              type="radio"
              name="page"
              value={p.pageId}
              disabled={!p.eligible}
              checked={pageId === p.pageId}
              onChange={() => setPageId(p.pageId)}
            />{' '}
            {p.name}
            {p.igUsername ? ` (Instagram @${p.igUsername})` : null}
            {p.eligible ? null : ' - your role on this Page cannot read its ads'}
            <br />
          </label>
        ))}
      </fieldset>
      <button type="button" onClick={start} disabled={busy || !pageId}>
        Scan this Page
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
