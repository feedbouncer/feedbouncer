import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export type UrlRejection =
  | 'invalid'
  | 'too_long'
  | 'not_https'
  | 'has_credentials'
  | 'port_not_allowed'
  | 'host_not_allowed'
  | 'private_address'
  | 'unresolvable';

type UrlCheck = { ok: true; url: URL } | { ok: false; reason: UrlRejection };

const MAX_URL_LENGTH = 2048;

type AddressPolicy = (ip: string) => boolean;

// Parses the allowed CIDRs once, so a bad entry fails at startup rather than per connection.
export function compileAddressPolicy(allowedPrivateCidrs: readonly string[]): AddressPolicy {
  const cidrs = allowedPrivateCidrs.map((c) => ipaddr.parseCIDR(c));
  return (ip) => {
    let addr: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      addr = ipaddr.process(ip);
    } catch {
      return false;
    }
    if (addr.range() === 'unicast') return true;
    return cidrs.some(([net, bits]) => net.kind() === addr.kind() && addr.match(net, bits));
  };
}

export function isAllowedAddress(ip: string, allowedPrivateCidrs: readonly string[]): boolean {
  return compileAddressPolicy(allowedPrivateCidrs)(ip);
}

export function checkUrlSyntax(
  input: string,
  o: { allowedPrivateCidrs?: readonly string[] } = {},
): UrlCheck {
  return checkSyntax(input, compileAddressPolicy(o.allowedPrivateCidrs ?? []));
}

export function checkSyntax(input: string, isAllowed: AddressPolicy): UrlCheck {
  if (input.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'has_credentials' };
  if (url.port !== '' && url.port !== '443') return { ok: false, reason: 'port_not_allowed' };
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIP(host) !== 0) {
    if (!isAllowed(host)) return { ok: false, reason: 'private_address' };
  } else if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
    return { ok: false, reason: 'host_not_allowed' };
  }
  url.hash = '';
  if (url.href.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true, url };
}

export async function validateWebhookUrl(
  input: string,
  o: { resolve(host: string): Promise<string[]>; allowedPrivateCidrs: readonly string[] },
): Promise<UrlCheck> {
  const isAllowed = compileAddressPolicy(o.allowedPrivateCidrs);
  const syntax = checkSyntax(input, isAllowed);
  if (!syntax.ok || isIP(syntax.url.hostname.replace(/^\[|\]$/g, '')) !== 0) return syntax;
  let addresses: string[];
  try {
    addresses = await o.resolve(syntax.url.hostname);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'unresolvable' };
  if (!addresses.every(isAllowed)) {
    return { ok: false, reason: 'private_address' };
  }
  return syntax;
}
