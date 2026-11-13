import 'server-only';
import type { OnboardingStateDto } from './onboarding';
import { dataOrThrow, serverGet } from './server-api';

// Callers must pass orgId through isUuid first.
export async function loadOnboarding(orgId: string): Promise<OnboardingStateDto> {
  return dataOrThrow(
    await serverGet<OnboardingStateDto>(`/api/v1/orgs/${orgId}/onboarding`),
    'onboarding',
  );
}
