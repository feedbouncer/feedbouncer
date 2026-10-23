'use client';
import type { ScanView } from '@feedbouncer/scan/contract';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../../lib/api-client';

const INTERVAL_MS = 2_000;
const GIVE_UP_MS = 6 * 60_000;

export function ScanPoller({ scanId }: { scanId: string }) {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    const started = Date.now();
    let stopped = false;
    const timer = setInterval(() => {
      if (Date.now() - started >= GIVE_UP_MS) {
        clearInterval(timer);
        setGaveUp(true);
        return;
      }
      apiFetch<ScanView>(`/api/v1/scan/scans/${scanId}`)
        .then((scan) => {
          if (stopped || scan.status === 'queued' || scan.status === 'running') return;
          clearInterval(timer);
          router.refresh();
        })
        .catch(() => undefined); // transient: the next tick retries
    }, INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [scanId, router]);

  return (
    <>
      <h1>Scanning your ads</h1>
      <p role="status">You can leave this page. Your result will be here when you come back.</p>
      {gaveUp ? <p>This is taking longer than expected. Reload the page to check again.</p> : null}
    </>
  );
}
