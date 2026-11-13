import { can } from '@feedbouncer/authz';
import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { WizardFrame } from '../../../../../components/onboarding/wizard-frame';
import { PageHeader } from '../../../../../components/ui/page-header';
import { isUuid } from '../../../../../lib/ids';
import { onboardingHref, parseStep } from '../../../../../lib/onboarding';
import { loadOnboarding } from '../../../../../lib/onboarding-server';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../../lib/server-api';

export default async function OnboardingStepPage({
  params,
}: {
  params: Promise<{ orgId: string; step: string }>;
}) {
  const { orgId, step: rawStep } = await params;
  const step = parseStep(rawStep);
  if (!isUuid(orgId) || !step) notFound();
  await requireMe(`/orgs/${orgId}/onboarding/${step}`);
  const t = await getTranslations('onboarding');
  const org = dataOrThrow(await serverGet<{ role: Role }>(`/api/v1/orgs/${orgId}`), 'organization');
  if (!can(org.role, 'org.update')) {
    return (
      <main>
        <p>{t('notAllowed')}</p>
      </main>
    );
  }
  const state = await loadOnboarding(orgId);
  if (!state.reachable[step]) redirect(onboardingHref(orgId, state.resumeStep ?? 'report'));
  return (
    <main className="flex flex-col gap-6">
      <PageHeader title={t('title')} />
      <WizardFrame orgId={orgId} state={state} step={step}>
        {/* Tasks 9 and 10 replace this placeholder with the real step components. */}
        <p>{t(`placeholder.${step}`)}</p>
      </WizardFrame>
    </main>
  );
}
