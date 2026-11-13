import 'server-only';
import type { OnboardingDefaultsDto, OnboardingReportDto, OnboardingStateDto } from './onboarding';
import { dataOrThrow, serverGet } from './server-api';

// Callers must pass orgId through isUuid first.
export async function loadOnboarding(orgId: string): Promise<OnboardingStateDto> {
  return dataOrThrow(
    await serverGet<OnboardingStateDto>(`/api/v1/orgs/${orgId}/onboarding`),
    'onboarding',
  );
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
