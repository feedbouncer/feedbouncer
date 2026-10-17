import { can } from '@feedbouncer/authz';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertsUnavailable } from '../../../../components/alerts/alerts-unavailable';
import { ChannelList } from '../../../../components/alerts/channel-list';
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
      <h1>Alerts</h1>
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
      <p>
        Choose which alerts each brand sends on the brand&apos;s Alerts page.{' '}
        <Link href={`/orgs/${orgId}`}>Back to organization</Link>
      </p>
    </main>
  );
}
