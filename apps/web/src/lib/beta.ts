// Mirrors normalizeAddress in packages/mailer (the API's rule for the same setting). It is
// not imported because the dev web container has no built workspace packages.
const SUPPORT_EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export interface BetaConfig {
  feedbackUrl: string | null;
  supportEmail: string | null;
}

function emailAddress(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase() ?? '';
  return value.length <= 254 && value.indexOf('@') <= 64 && SUPPORT_EMAIL.test(value)
    ? value
    : null;
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
    supportEmail: emailAddress(env.BETA_SUPPORT_EMAIL),
  };
}
