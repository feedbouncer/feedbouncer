import Link from 'next/link';
import { ApiForm } from '../../../components/api-form';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { ListPanel, ListRow } from '../../../components/ui/list';
import { PageHeader } from '../../../components/ui/page-header';
import { messageFor } from '../../../lib/messages';
import { requireMe } from '../../../lib/server-api';

export default async function OrgsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireMe('/orgs');
  const { error } = await searchParams;
  return (
    <main>
      <PageHeader title="My organizations" />
      {error === 'oauth_rejected' ? <p role="alert">{messageFor('oauth_rejected')}</p> : null}
      {!me.user.emailVerified ? (
        <Card className="border-coral/40">
          <CardContent className="flex flex-col gap-3">
            <p>Verify your email to create or join an organization.</p>
            <ApiForm
              action="/api/auth/send-verification-email"
              fields={[
                {
                  name: 'email',
                  label: 'Email',
                  type: 'email',
                  autoComplete: 'email',
                  defaultValue: me.user.email,
                },
              ]}
              submitLabel="Resend confirmation link"
              successMessage="If your address needs confirmation, we sent a new link."
              layout="inline"
              variant="primary"
            />
          </CardContent>
        </Card>
      ) : null}
      {me.memberships.length > 0 ? (
        <ListPanel>
          {me.memberships.map((m) => (
            <ListRow key={m.organizationId}>
              <div className="flex flex-col gap-0.5">
                <Link
                  href={`/orgs/${m.organizationId}`}
                  className="font-display text-card-title font-semibold"
                >
                  {m.organizationName}
                </Link>
                <span className="text-small text-dim capitalize">{m.role}</span>
              </div>
              <Link href={`/orgs/${m.organizationId}/comments`} className="text-small font-medium">
                All comments
              </Link>
            </ListRow>
          ))}
        </ListPanel>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Create an organization</CardTitle>
        </CardHeader>
        <CardContent>
          <ApiForm
            action="/api/v1/orgs"
            fields={[
              { name: 'name', label: 'Organization name', type: 'text' },
              { name: 'brandName', label: 'First brand', type: 'text' },
            ]}
            submitLabel="Create"
            refresh
            variant="primary"
          />
        </CardContent>
      </Card>
    </main>
  );
}
