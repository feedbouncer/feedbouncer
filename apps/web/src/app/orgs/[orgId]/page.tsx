import { can } from '@feedbouncer/authz';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertsNavLink } from '../../../components/alerts/alerts-nav-link';
import { ApiForm } from '../../../components/api-form';
import { CreateBrandForm } from '../../../components/create-brand-form';
import { OrgTimezoneForm } from '../../../components/org-timezone-form';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { ListPanel, ListRow } from '../../../components/ui/list';
import { PageHeader } from '../../../components/ui/page-header';
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
  const org = dataOrThrow(
    await serverGet<{
      organization: { id: string; name: string; timezone: string; timezoneSet: boolean };
      role: Role;
    }>(`/api/v1/orgs/${orgId}`),
    'organization',
  );
  const brandList = dataOrThrow(
    await serverGet<{ brands: Brand[] }>(`/api/v1/orgs/${orgId}/brands`),
    'brands',
  ).brands;
  const role = org.role;
  const canEdit = role !== 'member';
  return (
    <main>
      <PageHeader
        title={org.organization.name}
        actions={<Badge className="capitalize">{role}</Badge>}
      />
      {can(role, 'org.update') ? (
        <Card>
          <CardHeader>
            <CardTitle>Workspace settings</CardTitle>
          </CardHeader>
          <CardContent>
            <OrgTimezoneForm
              orgId={orgId}
              timezone={org.organization.timezone}
              timezoneSet={org.organization.timezoneSet}
            />
          </CardContent>
        </Card>
      ) : null}
      <section>
        <h2>Brands</h2>
        {brandList.length > 0 ? (
          <ListPanel>
            {brandList.map((b) => (
              <ListRow
                key={b.id}
                className="flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Link
                    href={`/orgs/${orgId}/brands/${b.id}/comments`}
                    className="font-display text-card-title font-semibold tracking-normal"
                  >
                    {b.name}
                  </Link>
                  <div className="flex flex-wrap gap-3 text-small">
                    {canEdit ? (
                      <Link href={`/orgs/${orgId}/brands/${b.id}/connections`}>Connections</Link>
                    ) : null}
                    <AlertsNavLink role={role} href={`/orgs/${orgId}/brands/${b.id}/alerts`} />
                  </div>
                </div>
                {canEdit ? (
                  <div className="flex flex-wrap items-start gap-4">
                    <ApiForm
                      action={`/api/v1/orgs/${orgId}/brands/${b.id}`}
                      method="PATCH"
                      fields={[
                        {
                          name: 'name',
                          label: 'Rename',
                          type: 'text',
                          defaultValue: b.name,
                        },
                      ]}
                      submitLabel="Save"
                      layout="inline"
                      size="sm"
                      refresh
                      className="w-44"
                    />
                    <ApiForm
                      action={`/api/v1/orgs/${orgId}/brands/${b.id}`}
                      method="PATCH"
                      fields={[
                        {
                          name: 'timezone',
                          label: `Timezone${b.timezoneSet ? '' : ' (using UTC)'}`,
                          type: 'text',
                          defaultValue: b.timezone,
                        },
                      ]}
                      submitLabel="Save"
                      layout="inline"
                      size="sm"
                      refresh
                      className="w-52"
                    />
                    <ApiForm
                      action={`/api/v1/orgs/${orgId}/brands/${b.id}/archive`}
                      fields={[]}
                      submitLabel="Archive"
                      variant="destructive"
                      size="sm"
                      refresh
                      className="self-end"
                    />
                  </div>
                ) : null}
              </ListRow>
            ))}
          </ListPanel>
        ) : (
          <p data-state="empty">No brands yet.</p>
        )}
        {canEdit ? (
          <Card>
            <CardHeader>
              <CardTitle>Add a brand</CardTitle>
            </CardHeader>
            <CardContent>
              <CreateBrandForm orgId={orgId} />
            </CardContent>
          </Card>
        ) : null}
      </section>
    </main>
  );
}
