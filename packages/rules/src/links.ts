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
// Fail closed: when a token could be a link, a host is emitted rather than dropped.
const MAX_LINKS = 50;
const MAX_TOKEN = 2048;
const SPLIT = /[\s<>"'`()[\]{}|^]+/u;
const PART_SPLIT = /[,;]/;
const TRAILING = /[.,!?;:…»”’)*_~]+$/u;
const LEADING = /^[«“‘(*_~]+/u;
const SCHEME = /^[a-z][a-z0-9+.-]{0,20}:\/\//i;
// Special schemes a browser accepts with missing or wrong slashes ("https:/x", "http:x", "https:/\x").
const SPECIAL_SCHEME = /^(https?|ftp|wss?):[/\\]*/i;
// Anchored and applied to one bounded token, so it cannot backtrack across the text.
const BARE_HOST =
  /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62})(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}))+(?::\d{1,5})?(?:[/?#].*)?$/u;
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

function mixedScript(unicodeHost: string): boolean {
  return unicodeHost.split('.').some((label) => SCRIPTS.filter((re) => re.test(label)).length > 1);
}

export interface LinkExtraction {
  links: LinkInfo[];
  /** True when the link cap stopped extraction, so later links were not examined. */
  truncated: boolean;
}

interface Candidate {
  text: string;
  hasScheme: boolean;
}

/** Candidate link texts for one whitespace-delimited token (bounded work per token). */
function candidates(token: string): Candidate[] {
  const out: Candidate[] = [];
  for (let part of token.slice(0, MAX_TOKEN).split(PART_SPLIT)) {
    part = part.replace(LEADING, '').replace(TRAILING, '');
    if (part.length < 4) continue;
    if (part.includes('\\')) {
      // A lenient parser treats "\" as an ordinary character, so "@" still starts the host.
      const authority = part.split(/[?#]/, 1)[0]!;
      const at = authority.lastIndexOf('@');
      if (at >= 0) out.push({ text: authority.slice(at + 1).replace(/\\/g, '/'), hasScheme: true });
      part = part.replace(/\\/g, '/'); // browser view
    }
    if (part.startsWith('//')) {
      out.push({ text: `http:${part}`, hasScheme: true });
      continue;
    }
    if (SPECIAL_SCHEME.test(part)) {
      out.push({
        text: part.replace(SPECIAL_SCHEME, (_m, s: string) => `${s.toLowerCase()}://`),
        hasScheme: true,
      });
      continue;
    }
    if (SCHEME.test(part)) {
      out.push({ text: part, hasScheme: true });
      continue;
    }
    // Schemeless: drop userinfo when the token is URL-like; plain "name@host" is an e-mail.
    const authority = part.split(/[/?#]/, 1)[0]!;
    const at = authority.lastIndexOf('@');
    let text = part;
    if (at >= 0) {
      const userinfo = authority.slice(0, at);
      const after = authority.slice(at + 1);
      const urlLike =
        part.length > authority.length || userinfo.includes(':') || after.includes(':');
      if (!urlLike) continue;
      text = part.slice(at + 1);
    }
    if (BARE_HOST.test(text)) out.push({ text, hasScheme: false });
  }
  return out;
}

export function extractLinksDetailed(raw: string): LinkExtraction {
  const seen = new Set<string>();
  const links: LinkInfo[] = [];
  let truncated = false;
  outer: for (const token of linkText(raw).split(SPLIT)) {
    if (token.length === 0) continue;
    for (const { text, hasScheme } of candidates(token)) {
      const host = asciiHost(text);
      if (host === null) continue;
      const r = parse(host, { extractHostname: false });
      if (!hasScheme && (r.isIp || r.domain === null || !(r.isIcann || r.isPrivate))) continue;
      if (seen.has(host)) continue;
      if (links.length >= MAX_LINKS) {
        truncated = true;
        break outer;
      }
      seen.add(host);
      const unicodeHost = domainToUnicode(host) || host;
      links.push({
        host,
        unicodeHost,
        mixedScript: mixedScript(unicodeHost),
        skeleton: latinSkeleton(unicodeHost),
      });
    }
  }
  return { links, truncated };
}

export function extractLinks(raw: string): LinkInfo[] {
  return extractLinksDetailed(raw).links;
}
