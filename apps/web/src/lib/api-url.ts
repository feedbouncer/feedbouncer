// Server-side config only, never request input, so the status probe cannot be steered (SSRF).
export function apiInternalUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): URL | null {
  const raw = env.API_INTERNAL_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
