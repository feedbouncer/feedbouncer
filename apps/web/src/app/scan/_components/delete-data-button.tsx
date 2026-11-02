'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { apiFetch } from '../../../lib/api-client';

export function DeleteDataButton() {
  const router = useRouter();
  const [error, setError] = useState(false);

  async function onClick() {
    setError(false);
    try {
      await apiFetch('/api/v1/scan/me', { method: 'DELETE' });
    } catch {
      setError(true);
      return;
    }
    router.refresh();
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={onClick}>
        Delete my data
      </Button>
      {error ? <p role="alert">Could not delete your data. Try again.</p> : null}
    </>
  );
}
