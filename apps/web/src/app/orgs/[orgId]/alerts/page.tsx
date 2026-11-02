import { can } from '@feedbouncer/authz';
import { notFound } from 'next/navigation';
import { AlertsUnavailable } from '../../../../components/alerts/alerts-unavailable';
import { ChannelList } from '../../../../components/alerts/channel-list';
import { PageHeader } from '../../../../components/ui/page-header';
import type { AlertChannelDto, Availability } from '../../../../lib/alerts';
import { isUuid } from '../../../../lib/ids';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../lib/server-api';

export default async function AlertsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  await requireMe(`/orgs/${orgId}/alerts`);
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  if (!can(org.role, 'alert.read')) notFound();
  const { availability, channels } = dataOrThrow(
    await serverGet<{ availability: Availability; channels: AlertChannelDto[] }>(
      `/api/v1/orgs/${orgId}/alert-channels`,
    ),
    'alert channels',
  );
  return (
    <main>
      <PageHeader
        title="Alerts"
        description="Workspace-wide alert channels. Choose which alerts each brand sends on the brand's Alerts page."
      />
      {availability.slack || availability.email ? (
        <ChannelList
          orgId={orgId}
          channels={channels}
          availability={availability}
          canManage={can(org.role, 'alert.manage')}
        />
      ) : (
        <AlertsUnavailable />
      )}
    </main>
  );
}
