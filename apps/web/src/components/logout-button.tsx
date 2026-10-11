'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch } from '../lib/api-client';

export function LogoutButton() {
  const router = useRouter();
  const [error, setError] = useState(false);
  async function logout() {
    setError(false);
    try {
      await apiFetch('/api/auth/sign-out', { method: 'POST' });
    } catch {
      setError(true);
      return;
    }
    router.push('/login');
  }
  return (
    <>
      <button type="button" onClick={logout}>
        Log out
      </button>
      {error ? <p role="alert">Could not log out. Try again.</p> : null}
    </>
  );
}
