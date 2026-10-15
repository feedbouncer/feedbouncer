import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RuleList } from '../../../../../../components/rules/rule-list';
import { isUuid } from '../../../../../../lib/ids';
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
  const brand = `/orgs/${orgId}/brands/${brandId}`;
  return (
    <main>
      <h1>Rules</h1>
      <p>
        Rules run top to bottom; the first match decides. Trusted authors are always checked first.
      </p>
      <p>
        <Link href={`${brand}/rules/new`}>New rule</Link> ·{' '}
        <Link href={`${brand}/rules/activity`}>Rule activity</Link> ·{' '}
        <Link href={`${brand}/domains`}>Own domains</Link>
      </p>
      <RuleList orgId={orgId} brandId={brandId} rules={rules} />
      <p>
        <Link href={`${brand}/comments`}>Comments</Link> ·{' '}
        <Link href={`/orgs/${orgId}`}>Back to organization</Link>
      </p>
    </main>
  );
}
