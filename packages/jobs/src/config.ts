import { PLATFORMS, type Platform } from '@feedbouncer/connectors';
import { EnvError, readInt, readString, type Env } from '@feedbouncer/service-runtime';
import type { JobRegistry } from './definition.js';
import { QUEUE_PREFIX } from './queues.js';
import {
  DEFAULT_RETRY_POLICY,
  DEFAULT_TIMEOUT_MS,
  resolvePolicy,
  retryHorizonMs,
  validatePolicy,
  type RetryPolicy,
} from './policy.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface JobsConfig {
  /** JOB_QUEUE_PREFIX, default `fb`. */
  readonly prefix: string;
  /** JOB_MAX_ATTEMPTS, JOB_BACKOFF_BASE_MS, JOB_BACKOFF_MAX_MS. */
  readonly defaultPolicy: RetryPolicy;
  /** JOB_CONCURRENCY (default 2), JOB_CONCURRENCY_<PLATFORM>; 0 disables the consumer. */
  readonly concurrency: Readonly<Record<Platform, number>>;
  readonly dlqRetentionMs: number;
  readonly dedupWindowMs: number;
  readonly sweepIntervalMs: number;
  readonly staleAfterMs: number;
  readonly bull: { readonly lockDurationMs: number; readonly stalledIntervalMs: number };
}

export function loadJobsConfig(env: Env): JobsConfig {
  const prefix = readString(env, 'JOB_QUEUE_PREFIX', {
    fallback: 'fb',
    maxLength: 32,
    pattern: QUEUE_PREFIX,
  });

  const base = readInt(env, 'JOB_CONCURRENCY', { min: 0, max: 64, fallback: 2 });
  const concurrency = Object.fromEntries(
    PLATFORMS.map((p) => [
      p,
      readInt(env, `JOB_CONCURRENCY_${p.toUpperCase()}`, { min: 0, max: 64, fallback: base }),
    ]),
  ) as Record<Platform, number>;

  let defaultPolicy: RetryPolicy;
  try {
    defaultPolicy = validatePolicy({
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: readInt(env, 'JOB_MAX_ATTEMPTS', {
        min: 1,
        max: 50,
        fallback: DEFAULT_RETRY_POLICY.maxAttempts,
      }),
      baseDelayMs: readInt(env, 'JOB_BACKOFF_BASE_MS', {
        min: 100,
        max: 600_000,
        fallback: DEFAULT_RETRY_POLICY.baseDelayMs,
      }),
      maxDelayMs: readInt(env, 'JOB_BACKOFF_MAX_MS', {
        min: 100,
        max: 86_400_000,
        fallback: DEFAULT_RETRY_POLICY.maxDelayMs,
      }),
    });
  } catch (e) {
    if (e instanceof RangeError) {
      throw new EnvError(
        'JOB_BACKOFF_MAX_MS must be at least JOB_BACKOFF_BASE_MS and the retry settings must be in range',
      );
    }
    throw e;
  }

  return {
    prefix,
    defaultPolicy,
    concurrency,
    dlqRetentionMs:
      readInt(env, 'JOB_DLQ_RETENTION_DAYS', { min: 1, max: 365, fallback: 14 }) * DAY_MS,
    dedupWindowMs:
      readInt(env, 'JOB_DEDUP_WINDOW_DAYS', { min: 1, max: 3_650, fallback: 30 }) * DAY_MS,
    sweepIntervalMs: 60_000,
    staleAfterMs: 300_000,
    bull: { lockDurationMs: 30_000, stalledIntervalMs: 30_000 },
  };
}

export function policyResolver(c: JobsConfig, jobs: JobRegistry): (jobType: string) => RetryPolicy {
  return (jobType) => resolvePolicy(c.defaultPolicy, jobs.get(jobType)?.policy);
}

/**
 * A ledger row has to outlive the longest time a job can stay queued plus the
 * time it can sit in the DLQ, or a replay could find its row already purged.
 */
export function assertDedupWindow(
  c: JobsConfig,
  jobs: JobRegistry,
  platforms: readonly Platform[],
): void {
  for (const platform of platforms) {
    const policyFor = policyResolver(c, jobs);
    for (const def of jobs.all()) {
      if (!jobs.supports(def.type, platform)) continue;
      const horizon = retryHorizonMs(policyFor(def.type), def.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (horizon + c.dlqRetentionMs > c.dedupWindowMs) {
        throw new Error(
          `JOB_DEDUP_WINDOW_DAYS must cover the retry horizon (${Math.ceil(horizon / HOUR_MS)} h) plus DLQ retention (${Math.ceil(c.dlqRetentionMs / DAY_MS)} d) for ${platform}/${def.type}`,
        );
      }
    }
  }
}
