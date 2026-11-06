import type { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { clientIpKey } from '../auth/client-ip.js';
import { ApiError } from '../http/errors.js';

/** Failed authentications allowed per address per window. */
export const PROVISIONING_AUTH_FAILURES = 10;
const WINDOW_SECONDS = 900;

export interface ProvisioningLimits {
  /** Throws 429 when the address used up its failed-authentication budget, 503 when Redis is unreachable; counts nothing. */
  assertAuthBudget(ip: string): Promise<void>;
  /** Counts one failed authentication from an address. Same errors as above. */
  consumeAuthFailure(ip: string): Promise<void>;
}

export function createProvisioningLimits(redis: Redis, prefix: string): ProvisioningLimits {
  const failures = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `${prefix}rl:prov-auth`,
    points: PROVISIONING_AUTH_FAILURES,
    duration: WINDOW_SECONDS,
  });
  const limited = (res: RateLimiterRes) =>
    new ApiError(429, 'rate_limited', undefined, undefined, {
      'retry-after': String(Math.max(1, Math.ceil(res.msBeforeNext / 1000))),
    });
  // rate-limiter-flexible rejects with RateLimiterRes over the limit and with an
  // Error when Redis fails. Fail closed on Redis errors.
  return {
    async assertAuthBudget(ip) {
      let used: RateLimiterRes | null;
      try {
        used = await failures.get(clientIpKey(ip));
      } catch {
        throw new ApiError(503, 'temporarily_unavailable');
      }
      if (used && used.consumedPoints >= failures.points) throw limited(used);
    },
    async consumeAuthFailure(ip) {
      try {
        await failures.consume(clientIpKey(ip));
      } catch (e) {
        if (!(e instanceof RateLimiterRes)) throw new ApiError(503, 'temporarily_unavailable');
        throw limited(e);
      }
    },
  };
}
