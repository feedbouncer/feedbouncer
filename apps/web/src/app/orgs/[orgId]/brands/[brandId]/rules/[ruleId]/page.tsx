import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ActionCapabilitiesDto } from '../../../../../../../lib/actions';
import { RuleEditor } from '../../../../../../../components/rules/rule-editor';
import { isUuid } from '../../../../../../../lib/ids';
import type { RuleView } from '../../../../../../../lib/rules';
import { dataOrThrow, requireMe, serverGet } from '../../../../../../../lib/server-api';

export default async function EditRulePage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string; ruleId: string }>;
}) {
  const { orgId, brandId, ruleId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId) || !isUuid(ruleId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/rules/${ruleId}`);
  const rule = dataOrThrow(
    await serverGet<RuleView>(`/api/v1/orgs/${orgId}/brands/${brandId}/rules/${ruleId}`),
    'rule',
  );
  const capabilities = dataOrThrow(
    await serverGet<ActionCapabilitiesDto>(
      `/api/v1/orgs/${orgId}/brands/${brandId}/action-capabilities`,
    ),
    'action capabilities',
  );
  return (
    <main>
      <h1>Edit rule</h1>
      <RuleEditor orgId={orgId} brandId={brandId} capabilities={capabilities} rule={rule} />
      <p>
        <Link href={`/orgs/${orgId}/brands/${brandId}/rules`}>Back to rules</Link>
      </p>
    </main>
  );
}
