// Only same-origin relative paths. Dot segments are normalized by URL parsing,
// so `/.//evil.com` becomes `//evil.com`; the normalized result is re-checked.
export function safeNextPath(raw: string | null | undefined, fallback = '/orgs'): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\'))
    return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    const base = 'http://local.invalid';
    const u = new URL(raw, base);
    if (u.origin !== base) return fallback;
    const path = `${u.pathname}${u.search}`;
    if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return fallback;
    return path;
  } catch {
    return fallback;
  }
}
