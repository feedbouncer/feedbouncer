import Link from 'next/link';
import { ApiForm } from '../../components/api-form';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const { token, error } = await searchParams;
  if (error || typeof token !== 'string' || token === '') {
    return (
      <main>
        <h1>Reset your password</h1>
        <p>This link is invalid or expired.</p>
        <Link href="/forgot-password">Request a new link</Link>
      </main>
    );
  }
  return (
    <main>
      <h1>Choose a new password</h1>
      <ApiForm
        action="/api/auth/reset-password"
        fields={[
          {
            name: 'newPassword',
            label: 'New password (at least 12 characters)',
            type: 'password',
            autoComplete: 'new-password',
          },
        ]}
        extraBody={{ token }}
        submitLabel="Set password"
        redirectTo="/login"
      />
    </main>
  );
}
