import { notFound } from 'next/navigation';
import { PolicyEditor } from '../../../../../../../components/policies/policy-editor';
import { BackLink } from '../../../../../../../components/ui/back-link';
import { PageHeader } from '../../../../../../../components/ui/page-header';
import { isUuid } from '../../../../../../../lib/ids';
import { requireMe } from '../../../../../../../lib/server-api';

export default async function NewPolicyPage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/policies/new`);
  return (
    <main>
      <BackLink href={`/orgs/${orgId}/brands/${brandId}/policies`}>Back to policies</BackLink>
      <PageHeader
        title="New policy"
        description={
          'Write one sentence about what to catch, for example “asks people to DM another account”. New policies start disabled, so you can preview them first.'
        }
      />
      <PolicyEditor orgId={orgId} brandId={brandId} mode="create" />
    </main>
  );
}
