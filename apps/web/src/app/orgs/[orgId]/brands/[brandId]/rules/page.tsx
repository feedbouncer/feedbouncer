import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RuleList } from '../../../../../../components/rules/rule-list';
import { buttonVariants } from '../../../../../../components/ui/button';
import { PageHeader } from '../../../../../../components/ui/page-header';
import { isUuid } from '../../../../../../lib/ids';
import type { RuleChangeView } from '../../../../../../lib/rule-changes';
import type { RuleView } from '../../../../../../lib/rules';
import { dataOrThrow, requireMe, serverGet } from '../../../../../../lib/server-api';

export default async function RulesPage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/rules`);
  const { rules } = dataOrThrow(
    await serverGet<{ rules: RuleView[] }>(`/api/v1/orgs/${orgId}/brands/${brandId}/rules`),
    'rules',
  );
  const { changes } = dataOrThrow(
    await serverGet<{ changes: RuleChangeView[] }>(
      `/api/v1/orgs/${orgId}/brands/${brandId}/rule-changes?status=pending`,
    ),
    'rule changes',
  );
  const brand = `/orgs/${orgId}/brands/${brandId}`;
  return (
    <main>
      <PageHeader
        title="Rules"
        description="Rules run top to bottom; the first match decides. Trusted authors are always checked first."
        actions={
          <>
            <Link href={`${brand}/rules/activity`} className="text-small font-medium">
              Rule activity
            </Link>
            <Link href={`${brand}/rules/new`} className={buttonVariants()}>
              New rule
            </Link>
          </>
        }
      />
      <RuleList orgId={orgId} brandId={brandId} rules={rules} pendingChanges={changes.length} />
    </main>
  );
}
