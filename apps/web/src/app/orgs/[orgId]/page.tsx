import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiForm } from '../../../components/api-form';
import { CreateBrandForm } from '../../../components/create-brand-form';
import { isUuid } from '../../../lib/ids';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../lib/server-api';

interface Brand {
  id: string;
  name: string;
  timezone: string;
  timezoneSet: boolean;
}

export default async function OrgPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  await requireMe(`/orgs/${orgId}`);
  const org = await serverGet<{ organization: { id: string; name: string }; role: Role }>(
    `/api/v1/orgs/${orgId}`,
  );
  if (!org.data) notFound();
  const brandList = dataOrThrow(
    await serverGet<{ brands: Brand[] }>(`/api/v1/orgs/${orgId}/brands`),
    'brands',
  ).brands;
  const canEdit = org.data.role !== 'member';
  return (
    <main>
      <h1>{org.data.organization.name}</h1>
      <p>Your role: {org.data.role}</p>
      <p>
        <Link href={`/orgs/${orgId}/comments`}>All comments</Link>
      </p>
      <h2>Brands</h2>
      <ul>
        {brandList.map((b) => (
          <li key={b.id}>
            <span>{b.name}</span>{' '}
            <Link href={`/orgs/${orgId}/brands/${b.id}/comments`}>Comments</Link>
            {canEdit ? (
              <>
                {' '}
                <Link href={`/orgs/${orgId}/brands/${b.id}/connections`}>Connections</Link>
              </>
            ) : null}
            {canEdit ? (
              <>
                <ApiForm
                  action={`/api/v1/orgs/${orgId}/brands/${b.id}`}
                  method="PATCH"
                  fields={[{ name: 'name', label: 'New name', type: 'text', defaultValue: b.name }]}
                  submitLabel="Rename"
                  refresh
                />
                <ApiForm
                  action={`/api/v1/orgs/${orgId}/brands/${b.id}`}
                  method="PATCH"
                  fields={[
                    {
                      name: 'timezone',
                      label: `Timezone${b.timezoneSet ? '' : ' (not set, using UTC)'}`,
                      type: 'text',
                      defaultValue: b.timezone,
                    },
                  ]}
                  submitLabel="Set timezone"
                  refresh
                />
                <ApiForm
                  action={`/api/v1/orgs/${orgId}/brands/${b.id}/archive`}
                  fields={[]}
                  submitLabel="Archive"
                  refresh
                />
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <>
          <h3>Add a brand</h3>
          <CreateBrandForm orgId={orgId} />
        </>
      ) : null}
      <p>
        <Link href={`/orgs/${orgId}/members`}>Members</Link> ·{' '}
        <Link href="/hidden-today">Hidden today</Link> · <Link href="/account">Account</Link>
      </p>
    </main>
  );
}
