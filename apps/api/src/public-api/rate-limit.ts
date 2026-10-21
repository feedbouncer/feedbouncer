import type { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { AUTH_FAILURES_PER_MINUTE } from '@feedbouncer/public-api';
import { clientIpKey } from '../auth/client-ip.js';
import { ApiError } from '../http/errors.js';

export interface PublicApiLimits {
  /** Counts one request of an API key. Throws 429 over the limit, 503 when Redis is unreachable. */
  consumeKey(apiKeyId: string): Promise<{ limit: number; remaining: number }>;
  /** Throws 429 when the address already used up its failed-authentication budget; counts nothing. */
  assertAuthBudget(ip: string): Promise<void>;
  /** Counts one failed authentication from an address. Same errors as above. */
  consumeAuthFailure(ip: string): Promise<void>;
}

export function createPublicApiLimits(
  redis: Redis,
  prefix: string,
  perMinute: number,
): PublicApiLimits {
  const mk = (name: string, points: number) =>
    new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: `${prefix}rl:${name}`,
      points,
      duration: 60,
    });
  const perKey = mk('public-key', perMinute);
  const authFailures = mk('public-auth', AUTH_FAILURES_PER_MINUTE);

  // rate-limiter-flexible rejects with RateLimiterRes when over the limit and
  // with an Error when Redis fails. Fail closed on Redis errors.
  const limited = (res: RateLimiterRes, perKeyHeaders: boolean) =>
    new ApiError(429, 'rate_limited', undefined, undefined, {
      'retry-after': String(Math.max(1, Math.ceil(res.msBeforeNext / 1000))),
      ...(perKeyHeaders
        ? { 'x-ratelimit-limit': String(perMinute), 'x-ratelimit-remaining': '0' }
        : {}),
    });
  const consume = async (
    limiter: RateLimiterRedis,
    key: string,
    perKeyHeaders = false,
  ): Promise<RateLimiterRes> => {
    try {
      return await limiter.consume(key);
    } catch (e) {
      if (!(e instanceof RateLimiterRes)) throw new ApiError(503, 'temporarily_unavailable');
      throw limited(e, perKeyHeaders);
    }
  };
  return {
    async consumeKey(apiKeyId) {
      const res = await consume(perKey, apiKeyId, true);
      return { limit: perMinute, remaining: res.remainingPoints };
    },
    async assertAuthBudget(ip) {
      let used: RateLimiterRes | null;
      try {
        used = await authFailures.get(clientIpKey(ip));
      } catch {
        throw new ApiError(503, 'temporarily_unavailable');
      }
      if (used && used.consumedPoints >= authFailures.points) throw limited(used, false);
    },
    async consumeAuthFailure(ip) {
      await consume(authFailures, clientIpKey(ip));
    },
  };
}
