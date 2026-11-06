import Link from 'next/link';
import { ApiForm } from '../../../components/api-form';
import { safeNextPath } from '../../../lib/safe-next';
import { invitationTokenFromNext, loadSignupEnabled } from '../../../lib/signup';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const nextPath = safeNextPath(typeof next === 'string' ? next : null);
  const signupEnabled = await loadSignupEnabled();
  const invitationToken = signupEnabled ? null : invitationTokenFromNext(nextPath);
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
        redirectTo={nextPath}
        variant="primary"
        fullWidthSubmit
      />
      <div className="flex flex-col gap-2 text-small">
        <Link href="/forgot-password">Forgot your password?</Link>
        {signupEnabled && <Link href="/sign-up">Create an account</Link>}
        {invitationToken && (
          <Link href={{ pathname: '/sign-up', query: { invitation: invitationToken } }}>
            Create an account to accept your invitation
          </Link>
        )}
      </div>
    </main>
  );
}
