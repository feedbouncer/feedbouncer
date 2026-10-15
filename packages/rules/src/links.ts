import { domainToUnicode } from 'node:url';
import { LinkifyIt } from 'linkify-it';
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
  /** True when a limit stopped extraction, so some links may not have been examined. */
  truncated: boolean;
}

// Links are only parsed, never fetched or resolved.
//
// Fail closed: the result is the union of two views of the text, and neither can hide
// a host the other found (except that "me@x.com" is an e-mail address, not a link).
//  1. Scheme view: URLs linkify-it recognises, re-read from the match start to the end
//     of the token with the WHATWG URL parser (userinfo, IPs, IPv6 literals, ports).
//  2. Host-run view: every dotted run of host-label characters, validated against the
//     public suffix list. It does not depend on the separators or markup around it.
const MAX_LINKS = 50;
const MAX_TOKEN = 2048;
/** Host validations one extraction may spend on cutting invalid runs; see runHosts. */
const MAX_RETRY_VALIDATIONS = 2000;
/** How far back an "@" is checked for a ":" that makes it URL userinfo. */
const USERINFO_LOOKBACK = 256;

const linkify = new LinkifyIt({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });

const TOKEN_END = /[\s<>"'`(){}|^,;]/g;
const TLN = /[\t\n\r]/;
const NON_TLN_SPACE = /[^\S\t\n\r]+/u;
// Host-label characters: any letter, digit or combining mark (IDN), "-" and "_".
const LABEL = /[\p{L}\p{N}\p{M}_-]/u;
// Same, but only scripts that build words with ASCII. A run of these that touches a CJK,
// Arabic, Thai, ... letter is a host glued to text ("点击evil.io"), so it is tried on its own.
const LATIN_LABEL =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Inherited}\p{N}_-]/u;
const EMAIL_LOCAL = /[\p{L}\p{N}\p{M}._%+-]/u;
const WHITESPACE = /\s/u;
const SEPARATORS = '.-_';
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

/**
 * Hosts of the URLs linkify-it finds in `text`. linkify-it stops a match at "@" and at
 * other characters a browser would keep, so the URL is re-read to the end of its token.
 * A backslash ends the authority for a browser but not for lenient parsers, so the host
 * after the last "@" is emitted as well.
 */
function schemeHosts(text: string, out: Set<string>): boolean {
  let truncated = false;
  for (const m of linkify.match(text) ?? []) {
    if (m.schema === 'mailto:') continue;
    TOKEN_END.lastIndex = m.index;
    const end = TOKEN_END.exec(text)?.index ?? text.length;
    let tail = text.slice(m.index, end);
    if (tail.length > MAX_TOKEN) {
      tail = tail.slice(0, MAX_TOKEN);
      truncated = true;
    }
    if (tail.startsWith('//')) tail = `http:${tail}`;
    const host = asciiHost(tail) ?? asciiHost(m.url);
    if (host !== null) out.add(host);
    if (tail.includes('\\')) {
      const authority = tail.slice(tail.indexOf('//') + 2).split(/[/?#]/, 1)[0]!;
      const at = authority.lastIndexOf('@');
      const lenient = at >= 0 ? asciiHost(authority.slice(at + 1).replace(/\\/g, '/')) : null;
      if (lenient !== null) out.add(lenient);
    }
  }
  return truncated;
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

/** "local@host": an e-mail address unless the "@" is URL userinfo ("u:pw@host", "x@host/path"). */
function isEmailHost(cps: string[], s: number, e: number): boolean {
  if (s < 2 || cps[s - 1] !== '@' || !EMAIL_LOCAL.test(cps[s - 2]!)) return false;
  if (e < cps.length && '/?#:'.includes(cps[e]!)) return false;
  for (let k = s - 2; k >= Math.max(0, s - USERINFO_LOOKBACK); k--) {
    if (WHITESPACE.test(cps[k]!)) break;
    if (cps[k] === ':') return false;
  }
  return true;
}

/**
 * Host-run view: hosts of every dotted label run in the text. A run that is not itself a
 * public domain also contributes its longest valid suffix and prefix (cut at ".", "-" or
 * "_"), which is what a linkifier with a TLD list or label-length limit would link. Cuts
 * cost host validations; once the budget is spent they stop and the result is truncated.
 */
function runHosts(text: string, out: Set<string>): boolean {
  const cps = Array.from(text);
  const n = cps.length;
  const full = cps.map((c) => LABEL.test(c));
  const latin = cps.map((c, k) => full[k]! && LATIN_LABEL.test(c));
  const seen = new Set<string>();
  let budget = MAX_RETRY_VALIDATIONS;
  let exhausted = false;
  const cutHost = (candidate: string): string | null => {
    if (budget <= 0) {
      exhausted = true;
      return null;
    }
    budget -= 1;
    return bareHost(candidate);
  };

  for (const isLabel of [full, latin]) {
    for (let [s, e] of dottedRuns(cps, isLabel)) {
      while (s < e && SEPARATORS.includes(cps[s]!)) s += 1;
      while (e > s && SEPARATORS.includes(cps[e - 1]!)) e -= 1;
      if (e - s < 3) continue;
      // "example.com@evil.io": the part before "@" is userinfo, the part after it is the host.
      if (e + 1 < n && cps[e] === '@' && full[e + 1]) continue;
      if (isEmailHost(cps, s, e)) continue;
      const run = cps.slice(s, e).join('');
      if (!run.includes('.') || seen.has(run)) continue;
      seen.add(run);
      budget -= 1;
      const whole = run.length <= MAX_HOST_CHARS ? bareHost(run) : null;
      if (whole !== null) {
        out.add(whole);
        continue;
      }
      const cuts: number[] = [];
      for (let k = 0; k < run.length; k++) if (SEPARATORS.includes(run.charAt(k))) cuts.push(k);
      const firstDot = run.indexOf('.');
      const lastDot = run.lastIndexOf('.');
      // Longest valid suffix (a suffix needs a dot), then longest valid prefix.
      for (const k of cuts) {
        if (k >= lastDot || exhausted) break;
        if (run.length - k - 1 > MAX_HOST_CHARS || SEPARATORS.includes(run.charAt(k + 1))) continue;
        const h = cutHost(run.slice(k + 1));
        if (h !== null) {
          out.add(h);
          break;
        }
      }
      for (let c = cuts.length - 1; c >= 0 && !exhausted; c--) {
        const k = cuts[c]!;
        if (k <= firstDot) break;
        if (k > MAX_HOST_CHARS || SEPARATORS.includes(run.charAt(k - 1))) continue;
        const h = cutHost(run.slice(0, k));
        if (h !== null) {
          out.add(h);
          break;
        }
      }
    }
  }
  return exhausted;
}

export function extractLinksDetailed(raw: string): LinkExtraction {
  const text = linkText(raw);
  const hosts = new Set<string>();
  let truncated = schemeHosts(text, hosts);
  if (TLN.test(text)) {
    // WHATWG URL parsing deletes tab/CR/LF anywhere, so a URL broken by them still navigates.
    for (const chunk of text.split(NON_TLN_SPACE))
      if (TLN.test(chunk))
        truncated = schemeHosts(chunk.replace(/[\t\n\r]+/g, ''), hosts) || truncated;
  }
  truncated = runHosts(text, hosts) || truncated;

  const links: LinkInfo[] = [];
  for (const host of hosts) {
    if (links.length >= MAX_LINKS) {
      truncated = true;
      break;
    }
    const unicodeHost = domainToUnicode(host) || host;
    links.push({
      host,
      unicodeHost,
      mixedScript: mixedScript(unicodeHost),
      skeleton: latinSkeleton(unicodeHost),
    });
  }
  return { links, truncated };
}

export function extractLinks(raw: string): LinkInfo[] {
  return extractLinksDetailed(raw).links;
}
