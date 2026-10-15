import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RuleEditor } from '../../../../../../../components/rules/rule-editor';
import { isUuid } from '../../../../../../../lib/ids';
import { requireMe } from '../../../../../../../lib/server-api';

export default async function NewRulePage({
  params,
}: {
  params: Promise<{ orgId: string; brandId: string }>;
}) {
  const { orgId, brandId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/rules/new`);
  return (
    <main>
      <h1>New rule</h1>
      <RuleEditor orgId={orgId} brandId={brandId} />
      <p>
        <Link href={`/orgs/${orgId}/brands/${brandId}/rules`}>Back to rules</Link>
      </p>
    </main>
  );
}
