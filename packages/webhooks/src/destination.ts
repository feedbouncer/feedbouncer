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

export function isAllowedAddress(ip: string, allowedPrivateCidrs: readonly string[]): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip);
  } catch {
    return false;
  }
  if (addr.range() === 'unicast') return true;
  return allowedPrivateCidrs.some((cidr) => {
    const [net, bits] = ipaddr.parseCIDR(cidr);
    return net.kind() === addr.kind() && addr.match(net, bits);
  });
}

// `anyPort` is for the send-time re-check, where the port was already vetted at registration.
export function checkUrlSyntax(
  input: string,
  o: { allowedPrivateCidrs?: readonly string[]; anyPort?: boolean } = {},
): UrlCheck {
  if (input.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'has_credentials' };
  if (!o.anyPort && url.port !== '' && url.port !== '443') {
    return { ok: false, reason: 'port_not_allowed' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host) !== 0) {
    return isAllowedAddress(host, o.allowedPrivateCidrs ?? [])
      ? { ok: true, url: withoutFragment(url) }
      : { ok: false, reason: 'private_address' };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
    return { ok: false, reason: 'host_not_allowed' };
  }
  return { ok: true, url: withoutFragment(url) };
}

function withoutFragment(url: URL): URL {
  url.hash = '';
  return url;
}

export async function validateWebhookUrl(
  input: string,
  o: { resolve(host: string): Promise<string[]>; allowedPrivateCidrs: readonly string[] },
): Promise<UrlCheck> {
  const syntax = checkUrlSyntax(input, { allowedPrivateCidrs: o.allowedPrivateCidrs });
  if (!syntax.ok || isIP(syntax.url.hostname.replace(/^\[|\]$/g, '')) !== 0) return syntax;
  let addresses: string[];
  try {
    addresses = await o.resolve(syntax.url.hostname);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'unresolvable' };
  if (!addresses.every((a) => isAllowedAddress(a, o.allowedPrivateCidrs))) {
    return { ok: false, reason: 'private_address' };
  }
  return syntax;
}
