import { can } from '@feedbouncer/authz';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertsUnavailable } from '../../../../../../components/alerts/alerts-unavailable';
import { BrandAlertSettings } from '../../../../../../components/alerts/brand-alert-settings';
import { RecentAlerts } from '../../../../../../components/alerts/recent-alerts';
import { PageHeader } from '../../../../../../components/ui/page-header';
import { channelName, type BrandAlertsView } from '../../../../../../lib/alerts';
import { isUuid } from '../../../../../../lib/ids';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../../../lib/server-api';

export default async function BrandAlertsPage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/alerts`);
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  if (!can(org.role, 'alert.read')) notFound();
  const view = dataOrThrow(
    await serverGet<BrandAlertsView>(`/api/v1/orgs/${orgId}/brands/${brandId}/alerts`),
    'alert settings',
  );
  const labels = Object.fromEntries(view.channels.map((c) => [c.id, channelName(c)]));
  const available = view.availability.slack || view.availability.email;
  return (
    <main>
      <PageHeader
        title="Alerts"
        description={
          <>
            Manage shared alert channels on the{' '}
            <Link href={`/orgs/${orgId}/alerts`}>workspace Alerts page</Link>.
          </>
        }
      />
      {available ? (
        <>
          <BrandAlertSettings
            orgId={orgId}
            brandId={brandId}
            view={view}
            canManage={can(org.role, 'alert.manage')}
          />
          <RecentAlerts events={view.recent} channelLabels={labels} />
        </>
      ) : (
        <AlertsUnavailable />
      )}
    </main>
  );
}
