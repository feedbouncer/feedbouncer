import { can } from '@feedbouncer/authz';
import { notFound, redirect } from 'next/navigation';
import { isUuid } from '../../../../lib/ids';
import { onboardingHref } from '../../../../lib/onboarding';
import { loadOnboarding } from '../../../../lib/onboarding-server';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../lib/server-api';

export default async function OnboardingIndex({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!isUuid(orgId)) notFound();
  await requireMe(`/orgs/${orgId}/onboarding`);
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  // Members get the not-allowed message from the step page.
  if (!can(org.role, 'org.update')) redirect(onboardingHref(orgId, 'connect'));
  const state = await loadOnboarding(orgId);
  redirect(onboardingHref(orgId, state.resumeStep ?? 'report'));
}
