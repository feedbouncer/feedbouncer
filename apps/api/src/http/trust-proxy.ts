// Fastify's trustProxy for TRUST_PROXY_HOPS. A number is handed to proxy-addr
// as a bare hop count: it would trust the first N hops whatever their address,
// so a client that reaches the API directly could spoof X-Forwarded-For and
// choose its own IP. Here a hop is trusted only if it is within the first N
// hops AND comes from an internal address (loopback, private, unique-local,
// link-local): a public peer is always treated as the client.
//
// Limit: this cannot tell a trusted proxy from any other internal peer. With
// Docker port publishing, direct requests arrive from the Docker gateway (a
// private address) and pass the check. So the API port must not be published
// to untrusted networks, and the proxy in front must overwrite, not append to,
// X-Forwarded-For.
import ipaddr from 'ipaddr.js';

const INTERNAL = new Set(['loopback', 'private', 'uniqueLocal', 'linkLocal']);

function isInternal(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  return INTERNAL.has(ipaddr.process(address).range());
}

export function trustProxyHops(hops: number): false | ((address: string, hop: number) => boolean) {
  if (hops <= 0) return false;
  return (address, hop) => hop < hops && isInternal(address);
}
