'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { apiFetch } from '../../../lib/api-client';
import { SHARE_LINK_NOTE } from './copy';

export function ShareControls({ scanId, shared }: { scanId: string; shared: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [isShared, setShared] = useState(shared);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, failure: string) {
    setError(null);
    try {
      await action();
    } catch {
      setError(failure);
    }
  }

  const share = () =>
    run(async () => {
      const res = await apiFetch<{ shareUrl: string }>(`/api/v1/scan/scans/${scanId}/share`, {
        method: 'PUT',
      });
      setUrl(res.shareUrl);
      setShared(true);
    }, 'Could not create a link. Try again.');

  const unshare = () =>
    run(async () => {
      await apiFetch(`/api/v1/scan/scans/${scanId}/share`, { method: 'DELETE' });
      setUrl(null);
      setShared(false);
    }, 'Could not stop sharing. Try again.');

  const remove = () =>
    run(async () => {
      await apiFetch(`/api/v1/scan/scans/${scanId}`, { method: 'DELETE' });
      router.push('/scan');
    }, 'Could not delete this result. Try again.');

  return (
    <section>
      <Card className="bg-elevated">
        <CardContent className="flex flex-col items-start gap-4">
          <h2>Share or delete</h2>
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={share}>
              {isShared ? 'Create a new link' : 'Create a share link'}
            </Button>
            {isShared ? (
              <Button type="button" variant="outline" onClick={unshare}>
                Stop sharing
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={remove}>
              Delete this result
            </Button>
          </div>
          {url ? (
            <p className="w-full">
              {SHARE_LINK_NOTE}{' '}
              <input readOnly value={url} aria-label="Share link" size={60} className="w-full" />
            </p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
        </CardContent>
      </Card>
    </section>
  );
}
