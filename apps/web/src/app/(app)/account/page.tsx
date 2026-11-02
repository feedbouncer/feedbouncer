import { ApiForm } from '../../../components/api-form';
import { LogoutButton } from '../../../components/logout-button';
import { ReportSubscriptionToggle } from '../../../components/reports/ReportSubscriptionToggle';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { PageHeader } from '../../../components/ui/page-header';
import { dataOrThrow, requireMe, serverGet } from '../../../lib/server-api';

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
      <PageHeader
        title="Account"
        description={me.user.email}
        actions={
          <>
            <Badge variant={me.user.emailVerified ? 'good' : 'coral'}>
              {me.user.emailVerified ? 'Email confirmed' : 'Email not confirmed'}
            </Badge>
            <LogoutButton />
          </>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Weekly report emails</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-dim">
            Every Monday morning, owners and admins get a summary of the past week for each
            workspace.
            {me.user.emailVerified ? null : ' Confirm your email address to receive it.'}
          </p>
          {subscriptions.length === 0 ? (
            <p className="text-dim">You are not an owner or admin of any workspace.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {subscriptions.map((s) => (
                <ReportSubscriptionToggle
                  key={s.organizationId}
                  orgId={s.organizationId}
                  orgName={s.organizationName}
                  subscribed={s.subscribed}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
        </CardHeader>
        <CardContent>
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
            variant="primary"
          />
        </CardContent>
      </Card>
      <Card className="border-danger/40">
        <CardHeader>
          <CardTitle>Delete account</CardTitle>
        </CardHeader>
        <CardContent>
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
            variant="destructive"
          />
        </CardContent>
      </Card>
    </main>
  );
}
