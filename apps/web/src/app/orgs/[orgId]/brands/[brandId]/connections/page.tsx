import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiForm } from '../../../../../../components/api-form';
import { ConnectButton } from '../../../../../../components/connect-button';
import { isUuid } from '../../../../../../lib/ids';
import { messageFor, statusReasonText } from '../../../../../../lib/messages';
import { missingPermissionText } from '../../../../../../lib/oauth';
import { CONNECTABLE, PLATFORM_COPY, isConnectable } from '../../../../../../lib/platforms';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../../../lib/server-api';

interface Connection {
  id: string;
  platform: string;
  displayName: string | null;
  status: 'connected' | 'needs_reconnect' | 'paused' | 'error' | 'disconnected';
  statusReason: string | null;
}

const STATUS_LABEL: Record<Connection['status'], string> = {
  connected: 'Connected',
  needs_reconnect: 'Needs reconnect',
  paused: 'Paused',
  error: 'Error',
  disconnected: 'Disconnected',
};

// Only these callback codes are shown, each as its own fixed sentence.
const ERROR_CODES: ReadonlySet<string> = new Set([
  'missing_permissions',
  'denied',
  'platform_error',
  'account_mismatch',
  'connection_inactive',
  'oauth_rejected',
]);

const platformLabel = (p: string): string => (isConnectable(p) ? PLATFORM_COPY[p].label : p);

const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' ? v : null);

export default async function ConnectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/connections`);
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  const sp = await searchParams;
  const errorParam = one(sp.error);
  const errorCode = errorParam !== null && ERROR_CODES.has(errorParam) ? errorParam : null;
  const canManage = org.role !== 'member';
  const connections = canManage
    ? dataOrThrow(
        await serverGet<{ connections: Connection[] }>(
          `/api/v1/orgs/${orgId}/brands/${brandId}/connections`,
        ),
        'connections',
      ).connections
    : [];
  const hasPageOrInstagram = connections.some(
    (c) => c.platform === 'facebook' || c.platform === 'instagram',
  );
  const hasAdAccount = connections.some((c) => c.platform === 'meta_ads');
  return (
    <main>
      <h1>Connections</h1>
      {errorCode ? (
        <div role="alert">
          <p>{messageFor(errorCode)}</p>
          {errorCode === 'missing_permissions' ? (
            <ul>
              {missingPermissionText(one(sp.missing)).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {canManage ? (
        <>
          {connections.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th scope="col">Platform</th>
                  <th scope="col">Account</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => {
                  const reason = statusReasonText(
                    c.statusReason ?? (c.status === 'needs_reconnect' ? 'needs_reconnect' : null),
                    c.platform,
                  );
                  return (
                    <tr key={c.id}>
                      <td>{platformLabel(c.platform)}</td>
                      <td>
                        <strong>{c.displayName ?? 'Unnamed account'}</strong>
                      </td>
                      <td>
                        {STATUS_LABEL[c.status]}
                        {reason ? <p>{reason}</p> : null}
                      </td>
                      <td>
                        {c.status === 'needs_reconnect' && isConnectable(c.platform) ? (
                          <ConnectButton
                            orgId={orgId}
                            brandId={brandId}
                            platform={c.platform}
                            label="Reconnect"
                            reconnectConnectionId={c.id}
                          />
                        ) : null}
                        <ApiForm
                          action={`/api/v1/orgs/${orgId}/brands/${brandId}/connections/${c.id}`}
                          method="DELETE"
                          fields={[]}
                          submitLabel="Disconnect"
                          refresh
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
          {CONNECTABLE.map((p) => (
            <ConnectButton
              key={p}
              orgId={orgId}
              brandId={brandId}
              platform={p}
              label={PLATFORM_COPY[p].connectLabel}
            />
          ))}
          {hasPageOrInstagram && !hasAdAccount ? (
            <p>Connect your ad account to moderate comments on your ads.</p>
          ) : null}
          <p>
            While the FeedBouncer Meta app is in review, only people with a role on the app can
            connect Pages and Instagram accounts.
          </p>
        </>
      ) : (
        <p>Only owners and admins can view and manage connections.</p>
      )}
      <p>
        <Link href={`/orgs/${orgId}/brands/${brandId}/comments`}>Comments</Link> ·{' '}
        <Link href={`/orgs/${orgId}/brands/${brandId}/ads`}>Ads</Link> ·{' '}
        <Link href={`/orgs/${orgId}`}>Back to organization</Link>
      </p>
    </main>
  );
}
