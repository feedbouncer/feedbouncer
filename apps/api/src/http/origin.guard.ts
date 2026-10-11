// CSRF defence for cookie-authenticated requests: a state-changing request must
// come from the web app's origin. Browsers always send Origin on cross-site
// POST/PUT/PATCH/DELETE; when it is absent, Sec-Fetch-Site must say same-origin.
// Anything else (no headers at all, "null", a foreign origin) is refused.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
type Headers = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function isTrustedOrigin(method: string, headers: Headers, webOrigin: string): boolean {
  if (SAFE.has(method.toUpperCase())) return true;
  const origin = one(headers.origin);
  if (origin !== undefined) return origin === webOrigin;
  return one(headers['sec-fetch-site']) === 'same-origin';
}
