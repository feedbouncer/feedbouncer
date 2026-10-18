import { can } from '@feedbouncer/authz';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiKeyManager } from '../../../../components/api-keys/api-key-manager';
import type { ApiKeyDto } from '../../../../lib/api-keys';
import { isUuid } from '../../../../lib/ids';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../lib/server-api';

export default async function ApiKeysPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  await requireMe(`/orgs/${orgId}/api-keys`);
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  if (!can(org.role, 'api_key.manage')) notFound();
  const { items } = dataOrThrow(
    await serverGet<{ items: ApiKeyDto[] }>(`/api/v1/orgs/${orgId}/api-keys`),
    'API keys',
  );
  return (
    <main>
      <h1>API keys</h1>
      <p>
        API keys let your own tools call the FeedBouncer API for this workspace. Read-only keys can
        read comments and flagged items. Read and write keys can also hide comments and manage
        webhooks.
      </p>
      <ApiKeyManager orgId={orgId} items={items} />
      <p>
        <Link href={`/orgs/${orgId}`}>Back to organization</Link>
      </p>
    </main>
  );
}
