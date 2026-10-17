import Link from 'next/link';
import { ApiForm } from '../../components/api-form';
import { LogoutButton } from '../../components/logout-button';
import { ReportSubscriptionToggle } from '../../components/reports/ReportSubscriptionToggle';
import { dataOrThrow, requireMe, serverGet } from '../../lib/server-api';

interface ReportSubscription {
  organizationId: string;
  organizationName: string;
  subscribed: boolean;
}

export default async function AccountPage() {
  const me = await requireMe('/account');
  const { subscriptions } = dataOrThrow(
    await serverGet<{ subscriptions: ReportSubscription[] }>('/api/v1/me/report-subscriptions'),
    'report subscriptions',
  );
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
      <section id="email-reports">
        <h2>Weekly report emails</h2>
        <p>
          Every Monday morning, owners and admins get a summary of the past week for each workspace.
          {me.user.emailVerified ? null : ' Confirm your email address to receive it.'}
        </p>
        {subscriptions.length === 0 ? (
          <p>You are not an owner or admin of any workspace.</p>
        ) : (
          subscriptions.map((s) => (
            <ReportSubscriptionToggle
              key={s.organizationId}
              orgId={s.organizationId}
              orgName={s.organizationName}
              subscribed={s.subscribed}
            />
          ))
        )}
      </section>
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
