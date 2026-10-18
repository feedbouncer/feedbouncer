import { normalizeAddress } from '@feedbouncer/mailer/address';

export interface BetaConfig {
  feedbackUrl: string | null;
  supportEmail: string | null;
}

function httpsUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? raw : null;
  } catch {
    return null;
  }
}

export function readBetaConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BetaConfig {
  return {
    feedbackUrl: httpsUrl(env.BETA_FEEDBACK_URL),
    supportEmail: normalizeAddress(env.BETA_SUPPORT_EMAIL),
  };
}
