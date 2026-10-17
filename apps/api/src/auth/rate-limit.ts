import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { ApiError } from '../http/errors.js';
import { clientIpKey } from './client-ip.js';

export interface AuthRateLimits {
  /**
   * Consumes one attempt for the account and the source IP BEFORE the password
   * is checked, so a parallel burst cannot outrun the counters. Throws 429
   * when either is exhausted, 503 when Redis is unreachable.
   */
  reserveLoginAttempt(email: string, ip: string): Promise<void>;
  /** After a verified password: clears the account counter and refunds the IP's point. */
  recordLoginSuccess(email: string, ip: string): Promise<void>;
  /** Counts one email-sending request. Throws 429 over the limit, 503 when Redis is unreachable. */
  consumeEmailSend(email: string, ip: string): Promise<void>;
  /** Counts one alert test send for a channel. Throws 429 over the limit, 503 when Redis is unreachable. */
  consumeAlertTest(channelId: string): Promise<void>;
  /** Counts one request to the public alert recipient routes from an IP. Same errors as above. */
  consumeAlertRecipient(ip: string): Promise<void>;
}

const h = (s: string) => createHash('sha256').update(s).digest('hex'); // no raw emails in Redis
const WINDOW = 15 * 60;

export function createAuthRateLimits(redis: Redis, prefix: string): AuthRateLimits {
  const mk = (name: string, points: number, duration: number, blockDuration = 0) =>
    new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: `${prefix}rl:${name}`,
      points,
      duration,
      blockDuration,
    });
  const loginAcct = mk('login_acct', 5, WINDOW, WINDOW);
  const loginIp = mk('login_ip', 20, WINDOW, WINDOW);
  const sendAcct = mk('send_acct', 3, 3600);
  const sendIp = mk('send_ip', 20, 3600);
  const alertTest = mk('alert_test', 5, 60);
  const alertRecipient = mk('alert_recipient_ip', 30, 60);

  const limited = () => new ApiError(429, 'rate_limited');
  const unavailable = () => new ApiError(503, 'temporarily_unavailable');
  // rate-limiter-flexible rejects with RateLimiterRes when over the limit and
  // with an Error when Redis fails. Fail closed on Redis errors.
  const consume = async (l: RateLimiterRedis, key: string) => {
    try {
      await l.consume(key);
    } catch (e) {
      throw e instanceof RateLimiterRes ? limited() : unavailable();
    }
  };
  return {
    async reserveLoginAttempt(email, ip) {
      const acct = h(email);
      await consume(loginAcct, acct);
      try {
        await consume(loginIp, clientIpKey(ip));
      } catch (e) {
        // Do not let a locked IP burn an account's budget.
        await loginAcct.reward(acct, 1).catch(() => undefined);
        throw e;
      }
    },
    async recordLoginSuccess(email, ip) {
      // The password was already verified; a Redis error here must not turn
      // the 200 being returned into a 500. The counters expire on their own.
      await Promise.all([
        loginAcct.delete(h(email)).catch(() => undefined),
        loginIp.reward(clientIpKey(ip), 1).catch(() => undefined),
      ]);
    },
    async consumeEmailSend(email, ip) {
      await consume(sendIp, clientIpKey(ip));
      await consume(sendAcct, h(email));
    },
    consumeAlertTest: (channelId) => consume(alertTest, channelId),
    consumeAlertRecipient: (ip) => consume(alertRecipient, clientIpKey(ip)),
  };
}
