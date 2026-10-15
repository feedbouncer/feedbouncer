import { parse } from 'tldts';

export const MAX_HOST_CHARS = 253;

// Never resolved or fetched: matching is by domain only (no SSRF surface).
export const SHORTENER_DOMAINS: readonly string[] = [
  'bit.ly',
  'bitly.com',
  't.co',
  'tinyurl.com',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  'rb.gy',
  'tiny.cc',
  's.id',
  't.ly',
  'lnkd.in',
  'trib.al',
  'bl.ink',
  'short.io',
  'v.gd',
  'qr.ae',
  'tr.im',
  'clck.ru',
  'u.to',
  'linktr.ee',
  'shorte.st',
  'adf.ly',
  'bit.do',
  'wa.me',
];

/** ASCII host of a URL or bare host via WHATWG URL (performs IDNA), or null. */
export function asciiHost(input: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  let host: string;
  try {
    host = new URL(withScheme).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, '');
  if (host.length === 0 || host.length > MAX_HOST_CHARS) return null;
  return host;
}

export function normalizeDomainEntry(input: string): string | null {
  const trimmed = input.trim().replace(/^\*\./, '');
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  const host = asciiHost(trimmed);
  if (host === null) return null;
  const r = parse(host, { extractHostname: false });
  if (r.isIp || r.domain === null || !(r.isIcann || r.isPrivate)) return null;
  return host.startsWith('www.') ? host.slice(4) : host;
}

export function isUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

// Small confusables table (Cyrillic/Greek letters that render like Latin). Not full UTS #39.
const CONFUSABLE: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ԁ: 'd',
  ӏ: 'l',
  ѕ: 's',
  ԛ: 'q',
  ԝ: 'w',
  ɡ: 'g',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
};
export function latinSkeleton(unicodeHost: string): string {
  let out = '';
  for (const ch of unicodeHost.toLowerCase()) out += CONFUSABLE[ch] ?? ch;
  return out;
}
