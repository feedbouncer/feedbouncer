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
// "[" and "]" are kept so IPv6 literals survive; they are trimmed per candidate.
const SPLIT = /[\s<>"'`(){}|^]+/u;
const TLN = /[\t\n\r]/;
const NON_TLN_SPACE = /[^\S\t\n\r]+/u;
const KEEP_LEADING = /[\p{L}\p{N}/\\]/u;
const TRAILING_CHARS = '.,!?;:\u2026\u00BB\u201D\u2019)*_~';
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

/** Linear scans (no regex backtracking). */
function trim(part: string): string {
  let start = 0;
  for (const ch of part) {
    if (KEEP_LEADING.test(ch)) break;
    start += ch.length;
  }
  let end = part.length;
  while (end > start) {
    const c = part.charAt(end - 1);
    if (
      TRAILING_CHARS.includes(c) ||
      part.charCodeAt(end - 1) <= 0x20 ||
      part.charCodeAt(end - 1) === 0x7f
    )
      end -= 1;
    else if (c === ']' && !part.includes('[', start)) end -= 1;
    else break;
  }
  return part.slice(start, end);
}

/** Split on "," and ";"; a comma between two digits keeps the part whole, and its comma-split tails are tried as well. */
function splitParts(token: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token.charAt(i);
    if (c !== ',' && c !== ';') continue;
    if (c === ',' && /\d/.test(token.charAt(i - 1)) && /\d/.test(token.charAt(i + 1))) continue;
    parts.push(token.slice(from, i));
    from = i + 1;
  }
  parts.push(token.slice(from));
  // Fail closed: a part kept whole by the digit exception may still hide a link after the comma.
  for (const part of parts.slice()) if (part.includes(',')) parts.push(...part.split(','));
  return parts;
}

export interface LinkExtraction {
  links: LinkInfo[];
  /** True when the link cap stopped extraction, so later links were not examined. */
  truncated: boolean;
}

interface Candidate {
  text: string;
  hasScheme: boolean;
  /** Scheme-relative: require a dotted host so "//todo" is not a link. */
  needsDot?: boolean;
}

/** Candidate link texts for one whitespace-delimited token (bounded work per token). */
function candidates(token: string): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of splitParts(token.slice(0, MAX_TOKEN))) {
    let part = trim(raw);
    if (part.length < 4) continue;
    if (part.includes('\\')) {
      // A lenient parser treats "\" as an ordinary character, so "@" still starts the host.
      const authority = part.split(/[?#]/, 1)[0]!;
      const at = authority.lastIndexOf('@');
      if (at >= 0) out.push({ text: authority.slice(at + 1).replace(/\\/g, '/'), hasScheme: true });
      part = part.replace(/\\/g, '/'); // browser view
    }
    if (part.startsWith('//')) {
      out.push({ text: `http:${part}`, hasScheme: true, needsDot: true });
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
      // "evil.io:80@good.com": a linkifier may read the userinfo as the host.
      const first = userinfo.split(':', 1)[0]!;
      if (userinfo.includes(':') && BARE_HOST.test(first))
        out.push({ text: first, hasScheme: false });
    }
    if (BARE_HOST.test(text)) out.push({ text, hasScheme: false });
  }
  return out;
}

export function extractLinksDetailed(raw: string): LinkExtraction {
  const seen = new Set<string>();
  const links: LinkInfo[] = [];
  let truncated = false;
  const text = linkText(raw);
  const work: { token: string; schemeOnly: boolean }[] = [];
  for (const token of text.split(SPLIT))
    if (token.length > 0) work.push({ token, schemeOnly: false });
  if (TLN.test(text)) {
    // WHATWG URL parsing deletes tab/CR/LF anywhere, so a scheme URL broken by them still navigates.
    for (const chunk of text.split(NON_TLN_SPACE)) {
      if (!TLN.test(chunk)) continue;
      for (const token of chunk.replace(/[\t\n\r]+/g, '').split(SPLIT)) {
        if (token.length > 0) work.push({ token, schemeOnly: true });
      }
    }
  }
  outer: for (const { token, schemeOnly } of work) {
    if (token.length > MAX_TOKEN) truncated = true;
    for (const { text: cand, hasScheme, needsDot } of candidates(token)) {
      if (schemeOnly && !hasScheme) continue;
      const host = asciiHost(cand);
      if (host === null) continue;
      if (needsDot && !host.includes('.')) continue;
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
