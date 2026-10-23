import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { clientIpKey } from '../auth/client-ip.js';
import { ApiError } from '../http/errors.js';

/** Each method throws 429 rate_limited (with retry-after) over a limit, 503 when Redis is unreachable. */
export interface ScanRateLimits {
  /** 10 per hour per IP. */
  authorize(ip: string): Promise<void>;
  /** Per day: 3 per visitor, 5 per IP, 5 per Facebook user and 3 per Page. */
  createScan(k: {
    ip: string;
    visitorId: string;
    fbUserHash: string;
    pageId: string;
  }): Promise<void>;
  /** 120 per minute per IP. */
  visitorRead(ip: string): Promise<void>;
  /** 60 per minute per IP. */
  sharedRead(ip: string): Promise<void>;
}

const h = (s: string) => createHash('sha256').update(s).digest('hex'); // no raw ids in Redis
const HOUR = 3600;
const DAY = 86_400;

export function createScanRateLimits(redis: Redis, prefix: string): ScanRateLimits {
  const mk = (name: string, points: number, duration: number) =>
    new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: `${prefix}rl:scan_${name}`,
      points,
      duration,
    });
  const authorizeIp = mk('authorize_ip', 10, HOUR);
  const createVisitor = mk('create_visitor', 3, DAY);
  const createIp = mk('create_ip', 5, DAY);
  const createFbUser = mk('create_fb_user', 5, DAY);
  const createPage = mk('create_page', 3, DAY);
  const readIp = mk('read_ip', 120, 60);
  const sharedIp = mk('shared_ip', 60, 60);

  // rate-limiter-flexible rejects with RateLimiterRes when over the limit and
  // with an Error when Redis fails. Fail closed on Redis errors.
  const consume = async (l: RateLimiterRedis, key: string) => {
    try {
      await l.consume(key);
    } catch (e) {
      if (!(e instanceof RateLimiterRes)) throw new ApiError(503, 'temporarily_unavailable');
      throw new ApiError(429, 'rate_limited', undefined, undefined, {
        'retry-after': String(Math.max(1, Math.ceil(e.msBeforeNext / 1000))),
      });
    }
  };
  return {
    authorize: (ip) => consume(authorizeIp, clientIpKey(ip)),
    async createScan(k) {
      const counters: [RateLimiterRedis, string][] = [
        [createVisitor, h(k.visitorId)],
        [createIp, clientIpKey(k.ip)],
        [createFbUser, h(k.fbUserHash)],
        [createPage, h(k.pageId)],
      ];
      const spent: [RateLimiterRedis, string][] = [];
      for (const [l, key] of counters) {
        try {
          await consume(l, key);
        } catch (e) {
          // One exhausted counter must not burn the others' budgets.
          await Promise.all(spent.map(([s, sk]) => s.reward(sk, 1).catch(() => undefined)));
          throw e;
        }
        spent.push([l, key]);
      }
    },
    visitorRead: (ip) => consume(readIp, clientIpKey(ip)),
    sharedRead: (ip) => consume(sharedIp, clientIpKey(ip)),
  };
}
