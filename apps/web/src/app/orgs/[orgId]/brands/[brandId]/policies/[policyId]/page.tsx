import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApplyRecent } from '../../../../../../../components/policies/apply-recent';
import { PolicyEditor } from '../../../../../../../components/policies/policy-editor';
import { RevisionHistory } from '../../../../../../../components/policies/revision-history';
import { isUuid } from '../../../../../../../lib/ids';
import { POLICY_ACTION_LABEL, type PolicyDetailDto } from '../../../../../../../lib/policies';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../../../../lib/server-api';

export default async function PolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; brandId: string; policyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId, brandId, policyId } = await params;
  if (!isUuid(orgId) || !isUuid(brandId) || !isUuid(policyId)) notFound();
  await requireMe(`/orgs/${orgId}/brands/${brandId}/policies/${policyId}`);
  const sp = await searchParams;
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  const policy = dataOrThrow(
    await serverGet<PolicyDetailDto>(
      `/api/v1/orgs/${orgId}/brands/${brandId}/policies/${policyId}`,
    ),
    'policy',
  );
  const canEdit = org.role !== 'member';
  return (
    <main>
      <h1>{canEdit ? 'Edit policy' : policy.name}</h1>
      {sp.created === '1' ? <p role="status">Policy created. Preview it before enabling.</p> : null}
      <p>{policy.enabled ? 'This policy is enabled.' : 'This policy is disabled.'}</p>
      {canEdit ? (
        <>
          <PolicyEditor orgId={orgId} brandId={brandId} mode="edit" policy={policy} />
          {policy.enabled ? (
            <ApplyRecent orgId={orgId} brandId={brandId} policyId={policy.id} />
          ) : null}
        </>
      ) : (
        <>
          <p>{POLICY_ACTION_LABEL[policy.action]}</p>
          <blockquote>{policy.text}</blockquote>
        </>
      )}
      <RevisionHistory revisions={policy.revisions} />
      <p>
        <Link
          href={`/orgs/${orgId}/brands/${brandId}/rules/activity?source=policy&policyId=${policy.id}`}
        >
          Activity for this policy
        </Link>{' '}
        · <Link href={`/orgs/${orgId}/brands/${brandId}/policies`}>Back to policies</Link>
      </p>
    </main>
  );
}
