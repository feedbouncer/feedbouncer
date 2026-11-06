import Link from 'next/link';
import { ApiForm } from '../../../components/api-form';
import { invitationTokenFrom, loadSignupEnabled, SIGNUP_DISABLED_TEXT } from '../../../lib/signup';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ invitation?: string | string[] }>;
}) {
  const invitationToken = invitationTokenFrom((await searchParams).invitation);
  const closed = !invitationToken && !(await loadSignupEnabled());
  return (
    <main>
      <h1>Create your account</h1>
      {closed ? (
        <p role="status">{SIGNUP_DISABLED_TEXT}</p>
      ) : (
        <ApiForm
          action="/api/v1/auth/sign-up"
          fields={[
            { name: 'name', label: 'Your name', type: 'text', autoComplete: 'name' },
            { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
            {
              name: 'password',
              label: 'Password (at least 12 characters)',
              type: 'password',
              autoComplete: 'new-password',
            },
          ]}
          submitLabel="Sign up"
          successMessage="Check your inbox for a confirmation link."
          variant="primary"
          fullWidthSubmit
          {...(invitationToken && { extraBody: { invitationToken } })}
        />
      )}
      <p className="text-small">
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </main>
  );
}
