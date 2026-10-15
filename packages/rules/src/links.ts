import { domainToUnicode } from 'node:url';
import { parse } from 'tldts';
import { asciiHost, latinSkeleton } from './domains.js';
import { linkText } from './normalize.js';

export interface LinkInfo {
  /** ASCII (punycode) host, lower-cased. */
  host: string;
  unicodeHost: string;
  mixedScript: boolean;
  /** latinSkeleton(unicodeHost) */
  skeleton: string;
}

// Links are only parsed, never fetched or resolved.
const MAX_LINKS = 50;
const MAX_TOKEN = 2048;
const SPLIT = /[\s<>"'`()[\]{}|\\^]+/u;
const TRAILING = /[.,!?;:…»”’)]+$/u;
const LEADING = /^[«“‘(]+/u;
const SCHEME = /^[a-z][a-z0-9+.-]{0,20}:\/\//i;
// Anchored and applied to one bounded token, so it cannot backtrack across the text.
const BARE_HOST =
  /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62})(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}))+(?::\d{1,5})?(?:[/?#].*)?$/u;
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

function mixedScript(unicodeHost: string): boolean {
  return unicodeHost.split('.').some((label) => SCRIPTS.filter((re) => re.test(label)).length > 1);
}

export function extractLinks(raw: string): LinkInfo[] {
  const seen = new Set<string>();
  const out: LinkInfo[] = [];
  for (let token of linkText(raw).split(SPLIT)) {
    if (out.length >= MAX_LINKS) break;
    token = token.replace(LEADING, '').replace(TRAILING, '');
    if (token.length < 4 || token.length > MAX_TOKEN) continue;
    const hasScheme = SCHEME.test(token);
    if (!hasScheme) {
      if (!BARE_HOST.test(token)) continue;
      const hostPart = token.split(/[/?#]/, 1)[0]!;
      if (hostPart.includes('@')) continue; // e-mail-like, not a link
    }
    const host = asciiHost(token);
    if (host === null) continue;
    const r = parse(host, { extractHostname: false });
    if (!hasScheme && (r.isIp || r.domain === null || !(r.isIcann || r.isPrivate))) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    const unicodeHost = domainToUnicode(host) || host;
    out.push({
      host,
      unicodeHost,
      mixedScript: mixedScript(unicodeHost),
      skeleton: latinSkeleton(unicodeHost),
    });
  }
  return out;
}
