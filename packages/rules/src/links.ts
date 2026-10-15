import { domainToUnicode } from 'node:url';
import { parse } from 'tldts';
import { MAX_HOST_CHARS, asciiHost, latinSkeleton } from './domains.js';
import { linkText } from './normalize.js';

export interface LinkInfo {
  /** ASCII (punycode) host, lower-cased. */
  host: string;
  unicodeHost: string;
  mixedScript: boolean;
  /** latinSkeleton(unicodeHost) */
  skeleton: string;
}

export interface LinkExtraction {
  links: LinkInfo[];
  /** True when the link cap stopped extraction, so later links were not examined. */
  truncated: boolean;
}

// Links are only parsed, never fetched or resolved.
//
// Fail closed: the result is the union of two independent views of each token.
//  1. URL view: the token (first MAX_TOKEN chars) parsed the way a browser would, plus
//     lenient-parser variants (backslash userinfo, embedded schemes, de-tabbed URLs).
//  2. Host-run view: every maximal dotted run of host-label characters anywhere in the
//     token, whatever surrounds it. This is what a linkifier can turn into a link, and it
//     does not depend on knowing every separator character.
// Both views only add hosts; nothing in one view can suppress a host found by the other,
// except the e-mail rule ("me@x.com" is an address, not a link).
const MAX_LINKS = 50;
const MAX_TOKEN = 2048;
// "[" and "]" are kept so IPv6 literals survive; they are trimmed per candidate.
const SPLIT = /[\s<>"'`(){}|^]+/u;
const TLN = /[\t\n\r]/;
const NON_TLN_SPACE = /[^\S\t\n\r]+/u;
const KEEP_LEADING = /[\p{L}\p{N}/\\]/u;
const TRAILING_CHARS = '.,!?;:…»”’)*_~';
const EMBEDDED_SCHEME = /(?:https?|ftp|wss?):\/\//gi;
const SCHEME = /^[a-z][a-z0-9+.-]{0,20}:\/\//i;
// Special schemes a browser accepts with missing or wrong slashes ("https:/x", "http:x", "https:/\x").
const SPECIAL_SCHEME = /^(https?|ftp|wss?):[/\\]*/i;
// Host-label characters: any letter, digit or combining mark (IDN), "-" and "_".
const LABEL = /[\p{L}\p{N}\p{M}_-]/u;
// Same, but only scripts that build words with ASCII. A run of these that touches a CJK,
// Arabic, Thai, ... letter is a host glued to text ("点击evil.io"), so it is tried on its own.
const LATIN_LABEL =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Inherited}\p{N}_-]/u;
const EMAIL_LOCAL = /[\p{L}\p{N}\p{M}._%+-]/u;
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

function mixedScript(unicodeHost: string): boolean {
  return unicodeHost.split('.').some((label) => SCRIPTS.filter((re) => re.test(label)).length > 1);
}

/** ASCII host of a schemeless candidate if it is a public (ICANN or private-suffix) domain name. */
function bareHost(text: string): string | null {
  const host = asciiHost(text);
  if (host === null) return null;
  const r = parse(host, { extractHostname: false });
  if (r.isIp || r.domain === null || !(r.isIcann || r.isPrivate)) return null;
  return host;
}

/** "scheme://host:junk/x" with the port removed, for a URL whose port is invalid. */
function withoutPort(url: string): string | null {
  const s = url.indexOf('://');
  if (s < 0) return null;
  let end = url.length;
  for (const c of '/?#') {
    const i = url.indexOf(c, s + 3);
    if (i >= 0 && i < end) end = i;
  }
  const hostStart = url.lastIndexOf('@', end - 1) + 1;
  const colon = url.lastIndexOf(':', end - 1);
  if (colon < Math.max(hostStart, s + 3) || url.lastIndexOf(']', end - 1) > colon) return null;
  return url.slice(0, colon) + url.slice(end);
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

/** Split on "," ";" "=" "&"; a comma between two digits keeps the part whole ("1,000.com" is one browser host). */
function splitParts(token: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token.charAt(i);
    if (c !== ',' && c !== ';' && c !== '=' && c !== '&') continue;
    if (c === ',' && /\d/.test(token.charAt(i - 1)) && /\d/.test(token.charAt(i + 1))) continue;
    parts.push(token.slice(from, i));
    from = i + 1;
  }
  parts.push(token.slice(from));
  return parts;
}

interface Candidate {
  text: string;
  hasScheme: boolean;
  /** Scheme-relative: require a dotted host so "//todo" is not a link. */
  needsDot?: boolean;
}

/** URL view: candidate link texts for one token, as browsers and lenient parsers read it. */
function urlCandidates(token: string): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of splitParts(token.slice(0, MAX_TOKEN))) {
    let part = trim(raw);
    if (part.length < 4) continue;
    // A scheme in the middle of a token ("see:https://x", "a.comhttps://x") starts another link.
    for (const m of part.matchAll(EMBEDDED_SCHEME)) {
      if (m.index > 0) out.push({ text: part.slice(m.index), hasScheme: true });
    }
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
    // Schemeless: the host a browser would use for "http://" + part.
    // Drop userinfo when the token is URL-like; plain "name@host" is an e-mail.
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
      if (userinfo.includes(':')) out.push({ text: userinfo.split(':', 1)[0]!, hasScheme: false });
    }
    out.push({ text, hasScheme: false });
  }
  return out;
}

/** Maximal runs of label characters joined by single dots, as [start, end) code point indexes. */
function dottedRuns(cps: string[], isLabel: boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  const n = cps.length;
  let i = 0;
  while (i < n) {
    if (!isLabel[i]) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < n && (isLabel[j] || (cps[j] === '.' && j + 1 < n && isLabel[j + 1]))) j += 1;
    runs.push([i, j]);
    i = j;
  }
  return runs;
}

const SEPARATORS = '.-_';

/**
 * Host-run view: hosts of every dotted label run in the token. A run that is not itself a
 * public domain also contributes its longest valid suffix and prefix (cut at ".", "-" or
 * "_"), which is what a linkifier with a TLD list or label-length limit would link.
 */
function runHosts(token: string): string[] {
  const cps = Array.from(token);
  const n = cps.length;
  const full = cps.map((c) => LABEL.test(c));
  const latin = cps.map((c, k) => full[k]! && LATIN_LABEL.test(c));
  const out: string[] = [];
  const seenRuns = new Set<string>();
  for (const isLabel of [full, latin]) {
    for (let [s, e] of dottedRuns(cps, isLabel)) {
      while (s < e && SEPARATORS.includes(cps[s]!)) s += 1;
      while (e > s && SEPARATORS.includes(cps[e - 1]!)) e -= 1;
      if (e - s < 3) continue;
      // E-mail address ("me@x.com") or userinfo of a URL ("example.com@evil.io"): the URL
      // view handles the URL-like forms; plain addresses are not links.
      if (s >= 2 && cps[s - 1] === '@' && EMAIL_LOCAL.test(cps[s - 2]!)) continue;
      if (e + 1 < n && cps[e] === '@' && full[e + 1]) continue;
      const run = cps.slice(s, e).join('');
      if (!run.includes('.') || seenRuns.has(run)) continue;
      seenRuns.add(run);
      const whole = run.length <= MAX_HOST_CHARS ? bareHost(run) : null;
      if (whole !== null) {
        out.push(whole);
        continue;
      }
      const cuts: number[] = [];
      for (let k = 0; k < run.length; k++) if (SEPARATORS.includes(run.charAt(k))) cuts.push(k);
      for (const k of cuts) {
        if (run.length - k - 1 > MAX_HOST_CHARS || SEPARATORS.includes(run.charAt(k + 1))) continue;
        const h = bareHost(run.slice(k + 1));
        if (h !== null) {
          out.push(h);
          break;
        }
      }
      for (let c = cuts.length - 1; c >= 0; c--) {
        const k = cuts[c]!;
        if (k > MAX_HOST_CHARS || SEPARATORS.includes(run.charAt(k - 1))) continue;
        const h = bareHost(run.slice(0, k));
        if (h !== null) {
          out.push(h);
          break;
        }
      }
    }
  }
  return out;
}

export function extractLinksDetailed(raw: string): LinkExtraction {
  const seen = new Set<string>();
  const links: LinkInfo[] = [];
  let truncated = false;

  /** Returns false once the link cap is hit. */
  const emit = (host: string): boolean => {
    if (seen.has(host)) return true;
    if (links.length >= MAX_LINKS) {
      truncated = true;
      return false;
    }
    seen.add(host);
    const unicodeHost = domainToUnicode(host) || host;
    links.push({
      host,
      unicodeHost,
      mixedScript: mixedScript(unicodeHost),
      skeleton: latinSkeleton(unicodeHost),
    });
    return true;
  };

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

  for (const { token, schemeOnly } of work) {
    if (token.length > MAX_TOKEN) truncated = true;
    for (const { text: cand, hasScheme, needsDot } of urlCandidates(token)) {
      if (schemeOnly && !hasScheme) continue;
      let host: string | null;
      if (hasScheme) {
        host = asciiHost(cand);
        if (host === null) {
          // Invalid port ("http://evil.io:abc/x"): a lenient linkifier still links the host.
          const stripped = withoutPort(cand);
          if (stripped !== null) host = asciiHost(stripped);
        }
        if (host !== null && needsDot && !host.includes('.')) host = null;
      } else {
        host = bareHost(cand);
      }
      if (host !== null && !emit(host)) return { links, truncated };
    }
    if (schemeOnly) continue;
    for (const host of runHosts(token)) if (!emit(host)) return { links, truncated };
  }
  return { links, truncated };
}

export function extractLinks(raw: string): LinkInfo[] {
  return extractLinksDetailed(raw).links;
}
