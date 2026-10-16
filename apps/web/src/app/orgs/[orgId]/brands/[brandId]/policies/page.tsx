import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PolicyList } from '../../../../../../components/policies/policy-list';
import { isUuid } from '../../../../../../lib/ids';
import type { PolicyListDto } from '../../../../../../lib/policies';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../../../lib/server-api';

export default async function PoliciesPage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/policies`);
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  const list = dataOrThrow(
    await serverGet<PolicyListDto>(`/api/v1/orgs/${orgId}/brands/${brandId}/policies`),
    'policies',
  );
  const brand = `/orgs/${orgId}/brands/${brandId}`;
  return (
    <main>
      <h1>Policies</h1>
      <p>
        Describe what to catch in plain language. Policies check comments that no rule has decided.
      </p>
      <PolicyList orgId={orgId} brandId={brandId} list={list} canEdit={org.role !== 'member'} />
      <p>
        <Link href={`${brand}/rules`}>Rules</Link> ·{' '}
        <Link href={`${brand}/rules/activity?source=policy`}>Policy activity</Link> ·{' '}
        <Link href={`${brand}/classifier`}>Classifier</Link> ·{' '}
        <Link href={`/orgs/${orgId}`}>Back to organization</Link>
      </p>
    </main>
  );
}
