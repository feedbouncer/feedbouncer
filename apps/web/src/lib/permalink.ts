const HOSTS: Record<string, readonly string[]> = {
  facebook: ['facebook.com'],
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  tiktok_ads: ['tiktok.com'],
  youtube: ['youtube.com'],
  threads: ['threads.com', 'threads.net'],
};

/**
 * A comment permalink is only linked when it is https on the platform's own
 * domains or a subdomain of one, with no credentials or port.
 */
export function viewOnUrl(platform: string, raw: string | null): string | null {
  if (!raw || !raw.startsWith('https://') || !Object.hasOwn(HOSTS, platform)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  return HOSTS[platform]!.some((d) => host === d || host.endsWith(`.${d}`)) ? raw : null;
}
