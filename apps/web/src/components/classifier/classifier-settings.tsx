'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiRequestError, apiFetch } from '../../lib/api-client';
import {
  rerunNotice,
  thresholdsKey,
  type PreviewResult,
  type ThresholdItem,
  type ThresholdView,
} from '../../lib/classifier';
import { messageFor } from '../../lib/messages';
import { PreviewPanel } from './preview-panel';
import { ThresholdTable } from './threshold-table';

const WINDOWS = [1, 7, 14, 30] as const;

export function ClassifierSettings(props: {
  orgId: string;
  brandId: string;
  categories: ThresholdView[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [days, setDays] = useState<number>(7);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const base = `/api/v1/orgs/${props.orgId}/brands/${props.brandId}/classifier` as const;

  async function attempt(fn: () => Promise<void>) {
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? (err.issues[0]?.message ?? messageFor(err.code))
          : 'Something went wrong.',
      );
    }
  }

  const save = (items: ThresholdItem[]) =>
    attempt(async () => {
      await apiFetch(`${base}/settings`, { method: 'PUT', body: { categories: items } });
      setPreview(null);
      setNotice('Thresholds saved.');
      router.refresh();
    });

  const runPreview = (items: ThresholdItem[]) =>
    attempt(async () => {
      setPreview(
        await apiFetch<PreviewResult>(`${base}/preview`, {
          method: 'POST',
          body: { categories: items, days },
        }),
      );
    });

  const rerun = () => {
    const ok = window.confirm(
      'Applies current thresholds to recent comments. New hides and deletes will be performed. Past decisions stay in the log.',
    );
    if (!ok) return;
    void attempt(async () => {
      const r = await apiFetch<{ enqueued: number; failed: number }>(`${base}/reruns`, {
        method: 'POST',
        body: { days },
      });
      setNotice(rerunNotice(r));
    });
  };

  return (
    <div>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <ThresholdTable
        key={thresholdsKey(props.categories)}
        onEdit={() => setPreview(null)}
        categories={props.categories}
        canEdit={props.canEdit}
        onSave={save}
        onPreview={runPreview}
      />
      {preview ? <PreviewPanel result={preview} /> : null}
      <label>
        Window{' '}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {WINDOWS.map((d) => (
            <option key={d} value={d}>
              Last {d} {d === 1 ? 'day' : 'days'}
            </option>
          ))}
        </select>
      </label>
      {props.canEdit ? (
        <p>
          <button type="button" onClick={rerun}>
            Re-run on the last {days} {days === 1 ? 'day' : 'days'}
          </button>
        </p>
      ) : null}
    </div>
  );
}
