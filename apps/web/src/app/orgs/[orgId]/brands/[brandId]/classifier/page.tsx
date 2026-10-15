import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ClassifierSettings } from '../../../../../../components/classifier/classifier-settings';
import { isUuid } from '../../../../../../lib/ids';
import type { ClassifierSettings as Settings } from '../../../../../../lib/classifier';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../../../lib/server-api';

export default async function ClassifierPage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/classifier`);
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  const { provider, categories } = dataOrThrow(
    await serverGet<Settings>(`/api/v1/orgs/${orgId}/brands/${brandId}/classifier/settings`),
    'classifier settings',
  );
  const brand = `/orgs/${orgId}/brands/${brandId}`;
  const canEdit = org.role !== 'member';
  return (
    <main>
      <h1>Classifier</h1>
      <p>
        {provider.enabled
          ? `Model: ${provider.id ?? 'unknown'} / ${provider.model ?? 'unknown'}`
          : 'No classifier configured: comments are recorded as not classified'}
      </p>
      <p>
        A comment is acted on when a category score reaches its threshold. Rules always run first.
      </p>
      <ClassifierSettings
        orgId={orgId}
        brandId={brandId}
        categories={categories}
        canEdit={canEdit}
      />
      <p>
        <Link href={`${brand}/rules`}>Rules</Link> ·{' '}
        <Link href={`${brand}/rules/activity`}>Rule activity</Link> ·{' '}
        <Link href={`/orgs/${orgId}`}>Back to organization</Link>
      </p>
    </main>
  );
}
