import { cookies } from 'next/headers';
import { ONBOARDING_RETURN_COOKIE } from './onboarding';

/** Whether this OAuth return was started from the wizard of this very organization. */
export async function isWizardReturn(orgId: string): Promise<boolean> {
  return (await cookies()).get(ONBOARDING_RETURN_COOKIE)?.value === orgId;
}
