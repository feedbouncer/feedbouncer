import Link from 'next/link';
import { ApiForm } from '../../components/api-form';
import { messageFor } from '../../lib/messages';
import { requireMe } from '../../lib/server-api';

export default async function OrgsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireMe('/orgs');
  const { error } = await searchParams;
  return (
    <main>
      <h1>My organizations</h1>
      {error === 'oauth_rejected' ? <p role="alert">{messageFor('oauth_rejected')}</p> : null}
      {!me.user.emailVerified ? (
        <section>
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
          />
        </section>
      ) : null}
      <ul>
        {me.memberships.map((m) => (
          <li key={m.organizationId}>
            <Link href={`/orgs/${m.organizationId}`}>{m.organizationName}</Link> ({m.role})
          </li>
        ))}
      </ul>
      <h2>Create an organization</h2>
      <ApiForm
        action="/api/v1/orgs"
        fields={[
          { name: 'name', label: 'Organization name', type: 'text' },
          { name: 'brandName', label: 'First brand', type: 'text' },
        ]}
        submitLabel="Create"
        refresh
      />
      <p>
        <Link href="/hidden-today">Hidden today</Link> · <Link href="/account">Account</Link>
      </p>
    </main>
  );
}
