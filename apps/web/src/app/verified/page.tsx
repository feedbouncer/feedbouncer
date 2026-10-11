import Link from 'next/link';
import { ApiForm } from '../../components/api-form';

export default async function VerifiedPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  if (error !== 'invalid_token') {
    return (
      <main>
        <h1>Email confirmed</h1>
        <p>Email confirmed. You can log in.</p>
        <Link href="/login">Log in</Link>
      </main>
    );
  }
  return (
    <main>
      <h1>Confirmation link problem</h1>
      <p>This link is invalid or expired.</p>
      <ApiForm
        action="/api/auth/send-verification-email"
        fields={[{ name: 'email', label: 'Email', type: 'email', autoComplete: 'email' }]}
        submitLabel="Send a new link"
        successMessage="If an account needs confirmation, we sent a new link."
      />
    </main>
  );
}
