export interface BetaConfig {
  feedbackUrl: string | null;
  supportEmail: string | null;
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;

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
  const email = env.BETA_SUPPORT_EMAIL;
  return {
    feedbackUrl: httpsUrl(env.BETA_FEEDBACK_URL),
    supportEmail: email && EMAIL.test(email) ? email : null,
  };
}
