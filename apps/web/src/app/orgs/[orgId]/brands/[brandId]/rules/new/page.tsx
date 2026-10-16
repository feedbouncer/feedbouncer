import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ActionCapabilitiesDto } from '../../../../../../../lib/actions';
import { RuleEditor } from '../../../../../../../components/rules/rule-editor';
import { isUuid } from '../../../../../../../lib/ids';
import { dataOrThrow, requireMe, serverGet } from '../../../../../../../lib/server-api';

export default async function NewRulePage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/rules/new`);
  const capabilities = dataOrThrow(
    await serverGet<ActionCapabilitiesDto>(
      `/api/v1/orgs/${orgId}/brands/${brandId}/action-capabilities`,
    ),
    'action capabilities',
  );
  return (
    <main>
      <h1>New rule</h1>
      <RuleEditor orgId={orgId} brandId={brandId} capabilities={capabilities} />
      <p>
        <Link href={`/orgs/${orgId}/brands/${brandId}/rules`}>Back to rules</Link>
      </p>
    </main>
  );
}
