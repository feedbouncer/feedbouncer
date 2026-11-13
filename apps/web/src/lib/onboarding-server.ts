import 'server-only';
import { unstable_rethrow } from 'next/navigation';
import type { OnboardingDefaultsDto, OnboardingReportDto, OnboardingStateDto } from './onboarding';
import { dataOrThrow, serverGet } from './server-api';

// Callers must pass orgId through isUuid first.
export async function loadOnboarding(orgId: string): Promise<OnboardingStateDto> {
  return dataOrThrow(
    await serverGet<OnboardingStateDto>(`/api/v1/orgs/${orgId}/onboarding`),
    'onboarding',
  );
}

/** For entry points: a failed load hides the wizard instead of breaking the page. */
export async function loadOnboardingOrNull(orgId: string): Promise<OnboardingStateDto | null> {
  try {
    return await loadOnboarding(orgId);
  } catch (e) {
    // redirect() and notFound() from the loader must still take effect.
    unstable_rethrow(e);
    return null;
  }
}

export async function loadOnboardingDefaults(orgId: string): Promise<OnboardingDefaultsDto> {
  return dataOrThrow(
    await serverGet<OnboardingDefaultsDto>(`/api/v1/orgs/${orgId}/onboarding/defaults`),
    'onboarding defaults',
  );
}

export async function loadOnboardingReport(orgId: string): Promise<OnboardingReportDto> {
  return dataOrThrow(
    await serverGet<OnboardingReportDto>(`/api/v1/orgs/${orgId}/onboarding/report`),
    'onboarding report',
  );
}
