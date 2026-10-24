const HOSTS: Record<string, string> = {
  facebook: 'facebook.com',
  instagram: 'instagram.com',
  tiktok: 'tiktok.com',
  tiktok_ads: 'tiktok.com',
};

/**
 * A comment permalink is only linked when it is https on the platform's own
 * domain or a subdomain of it, with no credentials or port.
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
  const domain = HOSTS[platform]!;
  return host === domain || host.endsWith(`.${domain}`) ? raw : null;
}
