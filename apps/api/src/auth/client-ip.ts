import ipaddr from 'ipaddr.js';

/** Rate-limit key for a client address: IPv4 as is, IPv6 reduced to its /64 prefix. */
export function clientIpKey(ip: string): string {
  try {
    let a = ipaddr.parse(ip);
    if (a.kind() === 'ipv6' && (a as ipaddr.IPv6).isIPv4MappedAddress()) {
      a = (a as ipaddr.IPv6).toIPv4Address();
    }
    if (a.kind() === 'ipv4') return a.toString();
    const parts = (a as ipaddr.IPv6).parts.slice(0, 4).map((p) => p.toString(16));
    return `${parts.join(':')}::/64`;
  } catch {
    return 'unknown';
  }
}
