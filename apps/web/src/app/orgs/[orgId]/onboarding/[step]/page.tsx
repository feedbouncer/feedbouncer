import { can } from '@feedbouncer/authz';
import { getTranslations } from 'next-intl/server';
import { notFound, redirect } from 'next/navigation';
import { StepConnect } from '../../../../../components/onboarding/step-connect';
import { StepDefaults } from '../../../../../components/onboarding/step-defaults';
import { StepReport } from '../../../../../components/onboarding/step-report';
import { StepReviewMode } from '../../../../../components/onboarding/step-review-mode';
import { WizardFrame } from '../../../../../components/onboarding/wizard-frame';
import { PageHeader } from '../../../../../components/ui/page-header';
import { isUuid } from '../../../../../lib/ids';
import { onboardingHref, parseStep, safeErrorCode } from '../../../../../lib/onboarding';
import {
  loadOnboarding,
  loadOnboardingDefaults,
  loadOnboardingReport,
} from '../../../../../lib/onboarding-server';
import { dataOrThrow, requireMe, serverGet, type Role } from '../../../../../lib/server-api';

export default async function OnboardingStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; step: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
  if (!state.reachable[step]) {
    const target = state.resumeStep ?? 'report';
    // Redirecting to the requested step itself would loop.
    if (target === step) notFound();
    redirect(onboardingHref(orgId, target));
  }
  return (
    <main className="flex flex-col gap-6">
      <PageHeader title={t('title')} />
      <WizardFrame orgId={orgId} state={state} step={step}>
        {step === 'connect' ? (
          <StepConnect
            orgId={orgId}
            state={state}
            error={safeErrorCode((await searchParams).error)}
          />
        ) : step === 'defaults' ? (
          <StepDefaults
            orgId={orgId}
            brandId={state.brand?.id}
            initial={await loadOnboardingDefaults(orgId)}
          />
        ) : step === 'review_mode' ? (
          <StepReviewMode orgId={orgId} state={state} />
        ) : (
          <StepReport orgId={orgId} initial={await loadOnboardingReport(orgId)} />
        )}
      </WizardFrame>
    </main>
  );
}
