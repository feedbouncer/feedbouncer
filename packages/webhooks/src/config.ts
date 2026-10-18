import ipaddr from 'ipaddr.js';
import { EnvError, type Env } from '@feedbouncer/service-runtime';

const NAME = 'WEBHOOK_ALLOWED_PRIVATE_CIDRS';

/** Networks, besides public ones, that webhook endpoints may point at (self-hosted setups). */
export function readAllowedPrivateCidrs(env: Env): string[] {
  const cidrs = (env[NAME] ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  for (const cidr of cidrs) {
    try {
      ipaddr.parseCIDR(cidr);
    } catch {
      throw new EnvError(`${NAME} contains an entry that is not a CIDR range, e.g. 10.0.0.0/8`);
    }
  }
  return cidrs;
}
