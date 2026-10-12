// Per-connection request budget shared by reads and actions. The key is the
// full tenant scope (scopeKey), never a bare connection id. Two counters
// with rate-limiter-flexible: "shared" (all work, `points` per window) and
// "bulk" (reads, `points - urgentReservePoints`). Bulk takes from both, urgent
// only from shared, so reads can never consume the urgent reserve. Platform
// hints (Retry-After, quota reports) override the local estimate via block()
// (clamped to 1 s..24 h) and penalty(). Store errors fail closed as transient
// (defer, never bypass).
import type { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { ConnectorError } from './errors.js';
import type { Platform, Priority, RateLimitPolicy } from './types.js';

export interface BudgetLimiter {
  consume(key: string, points?: number): Promise<unknown>;
  reward(key: string, points?: number): Promise<unknown>;
  penalty(key: string, points?: number): Promise<unknown>;
  block(key: string, secDuration: number): Promise<unknown>;
  get(key: string): Promise<{ remainingPoints: number } | null>;
}
export type LimiterFactory = (opts: {
  keyPrefix: string;
  points: number;
  duration: number;
}) => BudgetLimiter;
export type BudgetDecision =
  | { readonly granted: true }
  | { readonly granted: false; readonly retryAfterMs: number };

const unavailable = () => new ConnectorError('transient', 'budget_store_unavailable');
/** A platform hint can defer a connection by at most a day. */
const MAX_BLOCK_SEC = 86_400;
const blockSeconds = (ms: number) =>
  Math.min(Math.max(1, Math.ceil(ms / 1000) || 1), MAX_BLOCK_SEC);

async function take(l: BudgetLimiter, key: string): Promise<BudgetDecision> {
  try {
    await l.consume(key, 1);
    return { granted: true };
  } catch (e) {
    if (e instanceof RateLimiterRes)
      return { granted: false, retryAfterMs: Math.max(1, e.msBeforeNext) };
    throw unavailable();
  }
}

export class RateBudget {
  readonly #pairs = new Map<string, { shared: BudgetLimiter; bulk: BudgetLimiter }>();
  constructor(
    private readonly factory: LimiterFactory,
    private readonly prefix = 'fb:budget',
  ) {}

  #pair(platform: Platform, p: RateLimitPolicy) {
    const id = `${platform}:${p.points}:${p.durationSec}:${p.urgentReservePoints}`;
    let pair = this.#pairs.get(id);
    if (!pair) {
      pair = {
        shared: this.factory({
          keyPrefix: `${this.prefix}:${platform}:shared`,
          points: p.points,
          duration: p.durationSec,
        }),
        bulk: this.factory({
          keyPrefix: `${this.prefix}:${platform}:bulk`,
          points: p.points - p.urgentReservePoints,
          duration: p.durationSec,
        }),
      };
      this.#pairs.set(id, pair);
    }
    return pair;
  }

  async acquire(
    platform: Platform,
    key: string,
    policy: RateLimitPolicy,
    priority: Priority,
  ): Promise<BudgetDecision> {
    const { shared, bulk } = this.#pair(platform, policy);
    if (priority === 'bulk') {
      const b = await take(bulk, key);
      if (!b.granted) return b;
    }
    const s = await take(shared, key);
    if (!s.granted && priority === 'bulk') await bulk.reward(key, 1).catch(() => undefined);
    return s;
  }

  async applyPlatformHint(
    platform: Platform,
    key: string,
    policy: RateLimitPolicy,
    hint: { retryAfterMs: number },
  ): Promise<void> {
    try {
      await this.#pair(platform, policy).shared.block(key, blockSeconds(hint.retryAfterMs));
    } catch {
      throw unavailable();
    }
  }

  async applyQuotaReport(
    platform: Platform,
    key: string,
    policy: RateLimitPolicy,
    q: { remaining: number; resetAt: Date },
    nowMs: number,
  ): Promise<void> {
    if (!Number.isFinite(q.remaining) || Number.isNaN(q.resetAt.getTime())) return;
    if (q.remaining <= 0)
      return this.applyPlatformHint(platform, key, policy, {
        retryAfterMs: q.resetAt.getTime() - nowMs,
      });
    const { shared } = this.#pair(platform, policy);
    try {
      const res = await shared.get(key);
      const local = res ? res.remainingPoints : policy.points;
      if (q.remaining < local) await shared.penalty(key, Math.floor(local - q.remaining));
    } catch {
      throw unavailable();
    }
  }
}

export const memoryBudget = (): RateBudget => new RateBudget((o) => new RateLimiterMemory(o));
export const redisBudget = (redis: Redis, prefix?: string): RateBudget =>
  new RateBudget((o) => new RateLimiterRedis({ storeClient: redis, ...o }), prefix);
