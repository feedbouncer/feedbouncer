import Link from 'next/link';
import { ApiForm } from '../../components/api-form';
import { safeNextPath } from '../../lib/safe-next';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return (
    <main>
      <h1>Log in</h1>
      <ApiForm
        action="/api/auth/sign-in/email"
        fields={[
          { name: 'email', label: 'Email', type: 'email', autoComplete: 'username' },
          {
            name: 'password',
            label: 'Password',
            type: 'password',
            autoComplete: 'current-password',
          },
        ]}
        submitLabel="Log in"
        redirectTo={safeNextPath(typeof next === 'string' ? next : null)}
      />
      <p>
        <Link href="/forgot-password">Forgot your password?</Link>
      </p>
      <p>
        <Link href="/sign-up">Create an account</Link>
      </p>
    </main>
  );
}
