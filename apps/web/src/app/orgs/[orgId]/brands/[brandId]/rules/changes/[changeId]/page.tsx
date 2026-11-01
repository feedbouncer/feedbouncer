import { notFound } from 'next/navigation';
import { RuleChangeReview } from '../../../../../../../../components/rules/rule-change-review';
import { BackLink } from '../../../../../../../../components/ui/back-link';
import { PageHeader } from '../../../../../../../../components/ui/page-header';
import { isUuid } from '../../../../../../../../lib/ids';
import type { RuleChangeView } from '../../../../../../../../lib/rule-changes';
import {
  dataOrThrow,
  requireMe,
  serverGet,
  type Role,
} from '../../../../../../../../lib/server-api';

export default async function RuleChangePage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string; changeId: string }>;
}) {
  const { orgId, brandId, changeId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId) || !isUuid(changeId)) notFound();
  const rules = `/orgs/${orgId}/brands/${brandId}/rules`;
  await requireMe(`${rules}/changes/${changeId}`);
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  const change = dataOrThrow(
    await serverGet<RuleChangeView>(
      `/api/v1/orgs/${orgId}/brands/${brandId}/rule-changes/${changeId}`,
    ),
    'rule change',
  );
  return (
    <main>
      <BackLink href={`${rules}/changes`}>Back to rule changes</BackLink>
      <PageHeader title="Review rule change" />
      <RuleChangeReview
        orgId={orgId}
        brandId={brandId}
        change={change}
        canDecide={org.role !== 'member'}
      />
    </main>
  );
}
