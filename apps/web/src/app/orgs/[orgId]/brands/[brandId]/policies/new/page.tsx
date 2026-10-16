import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PolicyEditor } from '../../../../../../../components/policies/policy-editor';
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
      <h1>New policy</h1>
      <p>
        Write one sentence about what to catch, for example “asks people to DM another account”. New
        policies start disabled, so you can preview them first.
      </p>
      <PolicyEditor orgId={orgId} brandId={brandId} mode="create" />
      <p>
        <Link href={`/orgs/${orgId}/brands/${brandId}/policies`}>Back to policies</Link>
      </p>
    </main>
  );
}
