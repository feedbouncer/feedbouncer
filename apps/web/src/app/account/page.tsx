import Link from 'next/link';
import { ApiForm } from '../../components/api-form';
import { LogoutButton } from '../../components/logout-button';
import { requireMe } from '../../lib/server-api';

export default async function AccountPage() {
  const me = await requireMe('/account');
  return (
    <main>
      <h1>Account</h1>
      <p>
        {me.user.email} ({me.user.emailVerified ? 'email confirmed' : 'email not confirmed'})
      </p>
      <p>
        <Link href="/orgs">My organizations</Link>
      </p>
      <LogoutButton />
      <h2>Change password</h2>
      <ApiForm
        action="/api/auth/change-password"
        fields={[
          {
            name: 'currentPassword',
            label: 'Current password',
            type: 'password',
            autoComplete: 'current-password',
          },
          {
            name: 'newPassword',
            label: 'New password (at least 12 characters)',
            type: 'password',
            autoComplete: 'new-password',
          },
        ]}
        submitLabel="Change password"
        successMessage="Password changed."
      />
      <h2>Delete account</h2>
      <ApiForm
        action="/api/auth/delete-user"
        fields={[
          {
            name: 'password',
            label: 'Password',
            type: 'password',
            autoComplete: 'current-password',
          },
        ]}
        submitLabel="Delete my account"
        redirectTo="/"
      />
    </main>
  );
}
